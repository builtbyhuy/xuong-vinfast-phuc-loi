# When a row lock has no row to lock

Two photographs of the same plate can arrive together before that vehicle has an
active entry. The previous `process_vehicle` function selected an active row
with `FOR UPDATE`, then inserted an entry when no row was found. That protects an
existing row, but leaves the first-entry path unprotected.

The result is a specific integrity failure: both transactions can return `VAO`
and commit separate active entries for the same plate.

## Reproduce the failure, then change the lock boundary

The regression harness calls the actual PostgreSQL function through two separate
libpq connections. In a disposable test database, a `BEFORE INSERT` trigger
holds each insert at a controlled barrier. It does not change the RPC's lookup
or decision logic. Both clients must be observed waiting in PostgreSQL before
the barrier is released.

With the original function, both connections have already found no active row
when they reach the barrier. Each subsequently inserts a row. With the fix, one
call waits at that barrier while the other waits on the plate's transaction
lock, before its lookup. After the first commit, the second lookup sees the entry
and returns the existing burst-duplicate outcome.

| Same synthetic input and controlled interleaving | Original function | Fixed function |
| --- | --- | --- |
| Two simultaneous first-entry calls | `VAO` + `VAO` | `VAO` + `RA_DUPLICATE` |
| Active rows after both commits | 2 | 1 |
| Repeated controlled rounds | 5 of 5 reproduce the defect | 5 of 5 preserve one entry |

These are local PostgreSQL 16.15 results, not customer traffic or a load test.
The [baseline fixture](../test/fixtures/process-vehicle-before-plate-lock.sql)
preserves the exact original function from commit
`22935d3b2db0b1891e0a8d02bb7ea152ac4559a9`.

## The implementation decision

Take `pg_advisory_xact_lock` for a namespaced, 64-bit hash of the plate before
reading vehicle state. Retain `FOR UPDATE` on an existing row and leave the
threshold, timestamps, model field and returned action contract unchanged.

The lock belongs to the database transaction and releases on commit or rollback.
The usual short RPC transaction holds it only while deciding and writing state;
OCR, Telegram requests and spreadsheet work do not run inside the function.
Different plates use different keys and can proceed independently. A hash
collision could unnecessarily serialize two different plates; it would not
merge their records.

The tested contract is PostgreSQL **READ COMMITTED**, its default. The lock and
lookup are separate statements, so a lookup after waiting can observe the
preceding commit. This is cooperative coordination for callers of this RPC.
Direct table writes and stronger snapshot isolation need their own concurrency
contract. The fix does not add a global unique-active-plate constraint or repair
pre-existing duplicate records.

## Migration behavior matters too

[Migration 003](../supabase/migrations/003-lock-plate-before-lookup.sql) installs
the same function as the fresh-schema snapshot. The real upgrade check also
found an existing migration error: migration 002 added a six-argument overload,
then granted execution by function name alone. PostgreSQL rejected that grant
as ambiguous. The grant now names the exact six-argument signature.

The old five-argument overload also conflicts with the current function's
default arguments. Migration 003 removes that obsolete signature without
`CASCADE`. The current function still accepts five arguments through its model
default; the upgrade test exercises that call path with the same concurrency
barrier. Unexpected dependent objects stop the transaction instead of being
silently removed. Review dependencies before applying this migration to an
existing installation.

## Checks that protect the surrounding behavior

The real-database harness verifies:

- The first-entry interleaving above, with recorded `pg_stat_activity` waits and
  `pg_locks` identities.
- Entry → burst duplicate → legitimate exit → a new entry on the same day.
- Duplicate handling one second before the 900-second threshold, and an exit at
  the exact threshold; the vehicle-model field remains attached to the entry.
- Plate B completing while plate A's transaction and plate lock remain open.
- A waiting same-plate call proceeding correctly after the first transaction
  rolls back, with only the second entry committed.
- The existing unique message-key constraint rejecting a duplicate event with
  SQLSTATE `23505` and retaining one event row. This is a database constraint
  check, not a claim of exactly-once external delivery.

The fresh-schema run passes six checks. The migration run passes those checks
plus the five-argument call path. The installed six-argument function definition
has the same SHA-256 in both runs. JSON evidence retains source hashes,
PostgreSQL version, inputs, actual actions, row counts and observed locks:

- [Original behavior: expected regression failure](evidence/first-entry-baseline.json)
- [Fixed fresh schema](evidence/first-entry-fixed-schema.json)
- [Fixed migration path](evidence/first-entry-fixed-upgrade.json)

## Run against your own disposable local PostgreSQL

Use Python 3, libpq and a local PostgreSQL test administrator with `CREATEDB`.
The cluster must already contain a `service_role` role for the checked schema's
Supabase grant. Use a disposable local instance; this is not a production
database check. No app credentials or external service calls are needed.

Set libpq's normal `PGHOST`, `PGPORT`, `PGUSER` and `PGDATABASE` environment
variables. `LIBPQ_PATH` can identify a nonstandard libpq shared library. Then:

```sh
python3 test/postgres-concurrency.py --json fixed-schema.json
python3 test/postgres-concurrency.py --upgrade --json fixed-upgrade.json
```

To prove that the test detects the original defect, override only the RPC with
the preserved fixture:

```sh
python3 test/postgres-concurrency.py \
  --baseline-function test/fixtures/process-vehicle-before-plate-lock.sql \
  --race-only --json baseline.json
```

That baseline command **must exit 1** with two active rows in each round. The
fixed commands must exit 0. Each run creates a randomly named
`vehicle_regression_*` database, connects only to that new database for schema
and data changes, then drops that exact database. Connections have bounded
statement and observation timeouts.

## What this case establishes

An AI-assisted source review found a gap in an earlier concurrency claim. A
deterministic, real-database experiment reproduced it before the fix. The patch
changes the lock boundary and preserves the checked business transitions.

The checked result is the local PostgreSQL RPC: the controlled first-entry race,
the migration path and the surrounding database transitions above. The Node.js
adapter calls are unchanged; their comments now describe the actual lock
boundary. A reviewer can rerun both the preserved failure and the fix without
Telegram, OCR, spreadsheet or Supabase-account access.

References: PostgreSQL 16 [row and advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html),
[READ COMMITTED semantics](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED),
and [function defaults and overloads](https://www.postgresql.org/docs/16/sql-createfunction.html).
