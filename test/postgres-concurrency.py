#!/usr/bin/env python3
"""Real-PostgreSQL regression checks; no Telegram, OCR or Supabase API calls.

Connect as a local test administrator using PGHOST/PGPORT/PGUSER/PGDATABASE.
Creates and drops only a new randomly named vehicle_regression_* database.
Requires Python 3 and libpq (LIBPQ_PATH can name an extracted shared library).
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import ctypes
import ctypes.util
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
lib = ctypes.CDLL(os.environ.get("LIBPQ_PATH") or ctypes.util.find_library("pq"))
for name, restype, argtypes in (
    ("PQconnectdb", ctypes.c_void_p, [ctypes.c_char_p]),
    ("PQstatus", ctypes.c_int, [ctypes.c_void_p]),
    ("PQerrorMessage", ctypes.c_char_p, [ctypes.c_void_p]),
    ("PQexec", ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_char_p]),
    ("PQresultStatus", ctypes.c_int, [ctypes.c_void_p]),
    ("PQresultErrorMessage", ctypes.c_char_p, [ctypes.c_void_p]),
    ("PQresultErrorField", ctypes.c_char_p, [ctypes.c_void_p, ctypes.c_int]),
    ("PQntuples", ctypes.c_int, [ctypes.c_void_p]),
    ("PQnfields", ctypes.c_int, [ctypes.c_void_p]),
    ("PQgetvalue", ctypes.c_char_p, [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]),
    ("PQclear", None, [ctypes.c_void_p]),
    ("PQfinish", None, [ctypes.c_void_p]),
):
    fn = getattr(lib, name)
    fn.restype, fn.argtypes = restype, argtypes


def quote(value):
    return "'" + value.replace("'", "''") + "'"


class SqlError(RuntimeError):
    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


class Connection:
    def __init__(self, database=None, name="vehicle-regression-admin"):
        # Host/user/port use libpq's usual PG* environment variables.
        fields = f"application_name={name} connect_timeout=5"
        if database:
            fields += f" dbname={database}"
        self.ptr = lib.PQconnectdb(fields.encode())
        if lib.PQstatus(self.ptr) != 0:
            message = lib.PQerrorMessage(self.ptr).decode()
            self.close()
            raise RuntimeError(message)
        self.query("SET statement_timeout='8s'")

    def query(self, sql):
        result = lib.PQexec(self.ptr, sql.encode())
        if not result:
            raise RuntimeError(lib.PQerrorMessage(self.ptr).decode())
        try:
            if lib.PQresultStatus(result) not in (1, 2):
                code = lib.PQresultErrorField(result, ord("C"))
                raise SqlError(lib.PQresultErrorMessage(result).decode(),
                               code.decode() if code else "")
            return [[lib.PQgetvalue(result, row, col).decode()
                     for col in range(lib.PQnfields(result))]
                    for row in range(lib.PQntuples(result))]
        finally:
            lib.PQclear(result)

    def close(self):
        if self.ptr:
            lib.PQfinish(self.ptr)
            self.ptr = None


def wait_until(check, description):
    deadline = time.monotonic() + 5
    last = None
    while time.monotonic() < deadline:
        last = check()
        if last:
            return last
        time.sleep(0.01)
    raise AssertionError(f"Timed out waiting for {description}; last={last!r}")


def decision(conn, plate, trip, at="2026-10-22T08:00:00Z", limit=900, legacy=False):
    model_arg = "" if legacy else ", 'VF test'"
    return conn.query(
        "SELECT action, vehicle_id, seconds_in FROM process_vehicle("
        f"{quote(plate)}::text, {quote(trip)}::text, {quote(at)}::timestamptz, ''::text, {limit}{model_arg})"
    )[0]


def blocked_clients(admin, prefix):
    return admin.query(
        "SELECT application_name, wait_event_type, wait_event FROM pg_stat_activity "
        f"WHERE application_name LIKE {quote(prefix + '%')} "
        "AND state='active' AND wait_event_type='Lock' ORDER BY application_name"
    )


def first_entry_race(admin, database, legacy=False):
    # The only instrumentation is a BEFORE INSERT trigger in this disposable DB.
    # It stops the real RPC after its lookup but before its insert can complete.
    # Baseline: both calls reach this barrier after finding no active row.
    # Fixed: one reaches it; the other waits for the per-plate transaction lock.
    admin.query("""
      CREATE FUNCTION regression_insert_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.plate = 'TEST-RACE' THEN
          PERFORM pg_advisory_xact_lock_shared(2147483000, 1);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER regression_insert_barrier BEFORE INSERT ON vehicles
        FOR EACH ROW EXECUTE FUNCTION regression_insert_barrier();
    """)
    rounds = []
    try:
        for index in range(5):
            admin.query("TRUNCATE vehicles")
            admin.query("SELECT pg_advisory_lock(2147483000, 1)")
            clients = [Connection(database, f"vehicle-race-{index}-{n}") for n in (1, 2)]
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(decision, conn, "TEST-RACE", f"race-{index}-{n}", legacy=legacy)
                           for n, conn in enumerate(clients)]
                try:
                    def both_blocked():
                        for future in futures:
                            if future.done():
                                # Surface query errors rather than hiding them as a barrier timeout.
                                future.result()
                        rows = blocked_clients(admin, f"vehicle-race-{index}-")
                        return rows if len(rows) == 2 else None
                    waits = wait_until(
                        both_blocked,
                        "both RPC connections blocked at the controlled interleaving")
                    locks = admin.query("""
                        SELECT a.application_name, l.locktype, l.classid::text,
                               l.objid::text, l.objsubid::text, l.granted::text
                        FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
                        WHERE a.application_name LIKE 'vehicle-race-%'
                          AND l.locktype='advisory' ORDER BY 1,6
                    """)
                finally:
                    admin.query("SELECT pg_advisory_unlock(2147483000, 1)")
                results = [future.result(timeout=10) for future in futures]
            for conn in clients:
                conn.close()
            active = int(admin.query(
                "SELECT count(*) FROM vehicles WHERE plate='TEST-RACE' AND status='Đang trong xưởng'"
            )[0][0])
            rounds.append({"iteration": index + 1, "waits": waits,
                           "advisoryLocks": locks, "results": results,
                           "activeRows": active})
    finally:
        admin.query("DROP TRIGGER regression_insert_barrier ON vehicles; DROP FUNCTION regression_insert_barrier()")
    return {"pass": all(row["activeRows"] == 1 and
                         sorted(result[0] for result in row["results"]) == ["RA_DUPLICATE", "VAO"]
                         for row in rounds), "rounds": rounds}


def serial_semantics(admin):
    admin.query("TRUNCATE vehicles")
    results = [decision(admin, "TEST-SERIAL", "serial-in"),
               decision(admin, "TEST-SERIAL", "serial-burst", "2026-10-22T08:00:01Z"),
               decision(admin, "TEST-SERIAL", "serial-exit", "2026-10-22T09:00:00Z"),
               decision(admin, "TEST-SERIAL", "serial-reentry", "2026-10-22T09:05:00Z")]
    rows = admin.query("SELECT vehicle_id,status FROM vehicles ORDER BY time_in")
    return {"pass": [r[0] for r in results] == ["VAO", "RA_DUPLICATE", "RA", "VAO"]
            and rows == [["serial-in", "Đã ra xưởng"], ["serial-reentry", "Đang trong xưởng"]],
            "results": results, "rows": rows}


def threshold_boundary(admin):
    admin.query("TRUNCATE vehicles")
    start = decision(admin, "TEST-THRESHOLD", "threshold-in")
    before = decision(admin, "TEST-THRESHOLD", "threshold-before", "2026-10-22T08:14:59Z")
    at = decision(admin, "TEST-THRESHOLD", "threshold-at", "2026-10-22T08:15:00Z")
    model = admin.query("SELECT vehicle_model FROM vehicles WHERE vehicle_id='threshold-in'")[0][0]
    return {"pass": [r[0] for r in (start, before, at)] == ["VAO", "RA_DUPLICATE", "RA"]
            and model == "VF test", "results": [start, before, at], "vehicleModel": model}


def different_plates(admin, database):
    admin.query("TRUNCATE vehicles")
    first = Connection(database, "vehicle-independent-a")
    second = Connection(database, "vehicle-independent-b")
    try:
        first.query("BEGIN")
        a = decision(first, "TEST-PLATE-A", "independent-a")
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(decision, second, "TEST-PLATE-B", "independent-b")
            b = future.result(timeout=3)
            # A still has its transaction open and its plate lock held here.
            a_open = first.query("SELECT current_setting('transaction_isolation')")[0][0]
        first.query("ROLLBACK")
        rows = admin.query("SELECT vehicle_id FROM vehicles ORDER BY vehicle_id")
        return {"pass": a[0] == b[0] == "VAO" and rows == [["independent-b"]],
                "aResult": a, "bResultWhileAOpen": b, "aIsolation": a_open, "committedRows": rows}
    finally:
        first.close()
        second.close()


def rollback_releases_lock(admin, database):
    admin.query("TRUNCATE vehicles")
    first = Connection(database, "vehicle-rollback-a")
    second = Connection(database, "vehicle-rollback-b")
    try:
        first.query("BEGIN")
        a = decision(first, "TEST-ROLLBACK", "rolled-back")
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(decision, second, "TEST-ROLLBACK", "committed-after-rollback")
            try:
                waits = wait_until(lambda: blocked_clients(admin, "vehicle-rollback-b"),
                                   "same-plate call waiting for the open transaction")
            finally:
                first.query("ROLLBACK")
            b = future.result(timeout=10)
        rows = admin.query("SELECT vehicle_id FROM vehicles")
        return {"pass": a[0] == b[0] == "VAO" and rows == [["committed-after-rollback"]],
                "waits": waits, "first": a, "second": b, "committedRows": rows}
    finally:
        first.close()
        second.close()


def message_key_constraint(admin):
    admin.query("TRUNCATE events")
    admin.query("INSERT INTO events(event_id,timestamp,message_key) VALUES('event-a',now(),'synthetic-key')")
    code = None
    try:
        admin.query("INSERT INTO events(event_id,timestamp,message_key) VALUES('event-b',now(),'synthetic-key')")
    except SqlError as error:
        code = error.code
    count = admin.query("SELECT count(*) FROM events")[0][0]
    return {"pass": code == "23505" and count == "1", "duplicateSqlstate": code, "eventRows": int(count)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--baseline-function", type=Path)
    parser.add_argument("--upgrade", action="store_true", help="load migrations instead of the schema snapshot")
    parser.add_argument("--race-only", action="store_true")
    parser.add_argument("--quiet", action="store_true", help="print summary; full evidence still goes to --json")
    args = parser.parse_args()
    database = "vehicle_regression_" + uuid.uuid4().hex
    control = Connection()
    admin = None
    report = {"format": "vehicle-postgres-regression", "version": 1,
              "checkedAt": datetime.now(timezone.utc).isoformat(),
              "database": database, "mode": "upgrade" if args.upgrade else "fresh-schema",
              "serverVersion": control.query("SHOW server_version")[0][0],
              "baselineFunction": (str(args.baseline_function.resolve().relative_to(ROOT))
                                   if args.baseline_function else None),
              "scope": "synthetic local PostgreSQL RPC and constraint behavior; no external services"}
    try:
        control.query(f"CREATE DATABASE {database}")
        admin = Connection(database)
        if args.upgrade:
            for path in sorted((ROOT / "supabase/migrations").glob("*.sql")):
                admin.query(path.read_text(encoding="utf-8"))
        else:
            admin.query((ROOT / "supabase/schema.sql").read_text(encoding="utf-8"))
        if args.baseline_function:
            admin.query(args.baseline_function.read_text(encoding="utf-8"))
        definition = admin.query("SELECT pg_get_functiondef('process_vehicle(text,text,timestamptz,text,integer,text)'::regprocedure)")[0][0]
        report["installedFunctionSha256"] = hashlib.sha256(definition.encode()).hexdigest()
        paths = [Path(__file__), ROOT / "supabase/schema.sql",
                 ROOT / "supabase/migrations/002-add-vehicle-model.sql",
                 ROOT / "supabase/migrations/003-lock-plate-before-lookup.sql"]
        if args.baseline_function:
            paths.append(args.baseline_function.resolve())
        report["sourceSha256"] = {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in paths if path.exists()}
        report["firstEntryRace"] = first_entry_race(admin, database)
        if args.upgrade:
            report["legacyFiveArgumentRace"] = first_entry_race(admin, database, legacy=True)
        if not args.race_only:
            report["serialSemantics"] = serial_semantics(admin)
            report["thresholdBoundary"] = threshold_boundary(admin)
            report["differentPlates"] = different_plates(admin, database)
            report["rollbackReleasesLock"] = rollback_releases_lock(admin, database)
            report["messageKeyConstraint"] = message_key_constraint(admin)
        report["pass"] = all(value["pass"] for value in report.values()
                             if isinstance(value, dict) and "pass" in value)
    finally:
        if admin:
            admin.close()
        control.query(f"DROP DATABASE IF EXISTS {database} WITH (FORCE)")
        control.close()
    payload = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(payload, encoding="utf-8")
    print(json.dumps({key: value["pass"] for key, value in report.items()
                      if isinstance(value, dict) and "pass" in value})
          if args.quiet else payload)
    raise SystemExit(0 if report["pass"] else 1)


if __name__ == "__main__":
    main()
