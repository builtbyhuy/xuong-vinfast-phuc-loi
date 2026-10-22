# Supabase Migration Guide — VinFast Bot Setup

**Current correction:** apply and review migration 003 for the per-plate RPC lock.
The [real PostgreSQL concurrency case](CASE-CONCURRENT-FIRST-ENTRY.md) records
the original failure, checked fix and upgrade behavior. This guide is not proof
that a particular database has received the migration.

---

## What Changed

The codebase already uses **Supabase as the primary database** (source of truth), but the documentation was outdated and only mentioned Google Sheets.

This update brings the documentation in sync with the actual architecture:

```
Telegram Bot
  ↓ (OCR)
Node.js App
  ↓ (Write)
Supabase PostgreSQL ← SOURCE OF TRUTH
  ↓ (Async sync)
Google Sheets ← Read-only mirror for humans
```

---

## 5 Things Updated

### 1. Schema Migration (NEW FILE)
**Location:** `supabase/migrations/001-init-schema.sql`

Contains:
- 3 tables: `vehicles`, `events`, `reviews`
- Intelligent indexes for fast lookups
- `process_vehicle()` RPC function for vehicle-state decisions
- Full SQL comments explaining each column and index
- Ready to copy-paste into Supabase SQL editor

**Lock boundary:** `SELECT FOR UPDATE` alone does not protect a first entry when
there is no active row. Migration 003 takes a per-plate transaction advisory lock
before the lookup, then retains the row lock. Its checked contract is READ
COMMITTED for callers of this RPC; direct table writes need separate coordination.

### 2. Setup Guide Updated
**Location:** `SETUP_GUIDE.md`

Added **Step 3: Create Supabase Database** between Google Sheets (Step 2) and Google Cloud (Step 4).

Includes:
- How to create free Supabase project
- Where to find Project URL and Service Role Key
- How to run the migration (copy → paste → run)
- Verification steps (check Table Editor)

### 3. Deployment Checklist Updated
**Location:** `DEPLOYMENT_CHECKLIST.md`

Added **BƯỚC 3: SUPABASE POSTGRESQL SETUP** with detailed steps:
- Create project
- Copy credentials
- Run migration SQL
- Verify tables exist
- Troubleshooting for SQL errors

All subsequent steps renumbered (4→5, 5→6, 6→7).

### 4. Environment Template Updated
**Location:** `.env.template`

Added complete Supabase section:
- `SUPABASE_URL` — Your project's API endpoint
- `SUPABASE_SERVICE_KEY` — Authentication token (keep secret!)
- Comments explaining what each credential means
- Reorganized into logical sections

### 5. Deploy Checklist Script (NEW FILE)
**Location:** `scripts/deploy-checklist.sh`

One-command validation before deployment:
```bash
./scripts/deploy-checklist.sh
```

Checks:
- All env vars set and non-empty
- JSON credentials are valid
- Supabase connection works (curl test)
- Google credentials have required fields
- Local dependencies installed (Node.js, npm)
- Source code files exist

Output:
- Color-coded results (✓ ✗ ⚠)
- Summary: Passed/Failed/Warnings
- Exit 0 = ready to deploy
- Exit 1 = fix errors first
- Actionable next steps

---

## Deployment Order

Before running the bot, you need to:

### Step 1-2: Basic Setup (Same as before)
1. Create Telegram bot → Get `TELEGRAM_BOT_TOKEN`
2. Create Google Sheet → Get `GOOGLE_SHEET_ID`

### Step 3: **NEW — Create Supabase** ⭐
3. Create free Supabase project
4. For a new empty database, use the current `supabase/schema.sql` snapshot.
5. For an existing installation, review and apply only the outstanding migrations in order: `001` → `002` → `003`. Migration `003` installs the plate lock and removes the obsolete five-argument overload; do not rerun `001` after it. See [the concurrency case](CASE-CONCURRENT-FIRST-ENTRY.md) for the tested upgrade path.
6. Get `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`

### Step 4-5: Google Setup (Same as before)
7. Create Google Service Account → Get `GOOGLE_CREDENTIALS_JSON`
8. Share Google Sheet with service account

### Step 6: Configure & Test
9. Create `.env` file with all credentials
10. Run `./scripts/deploy-checklist.sh` to validate
11. Fix any errors and re-run until all checks pass

### Step 7-8: Deploy
12. Deploy to Render/Railway/VPS
13. Test bot (send photos, check both Supabase AND Google Sheets)

---

## Key Credentials

Three critical secrets — never commit to git:

| Secret | Purpose | Where from |
|--------|---------|-----------|
| `SUPABASE_SERVICE_KEY` | DB admin access | Supabase Settings > API |
| `GOOGLE_CREDENTIALS_JSON` | Sheets & Vision API | Google Cloud Service Account JSON |
| `TELEGRAM_BOT_TOKEN` | Bot authentication | @BotFather on Telegram |

---

## Data Architecture

### Supabase (Source of Truth)
- All transactional data written here first
- `process_vehicle()` RPC handles VAO/RA decisions
- Atomic, race-condition-safe
- Permanent audit trail (events, reviews tables)

### Google Sheets (Human Mirror)
- Updated asynchronously from Supabase
- Read-only for human viewing
- Guards can still see real-time updates
- Used for daily reporting

---

## Testing the Migration

### Local Test (Before Deployment)
```bash
# 1. Copy template
cp .env.template .env

# 2. Fill in your Supabase, Google, and Telegram credentials
# (Edit .env with your actual keys)

# 3. Run validation
./scripts/deploy-checklist.sh

# 4. Fix any errors, run again until all pass
```

### Supabase Verification
After running the migration:

1. Go to https://supabase.com → your project
2. Click **Table Editor** (left sidebar)
3. You should see 3 tables:
   - `vehicles`
   - `events`
   - `reviews`
4. Click each table to verify columns

### Bot Test (After Deployment)
1. Send `/start` to bot → should respond
2. Send `TONKHO` → should show any vehicles in workshop
3. Send a license plate photo → bot should recognize it
4. Check Supabase: `vehicles` table should have new row
5. Check Google Sheet: should also have new row (async update)

---

## Troubleshooting

### "SQL Error: syntax error"
- Copy migration file again (fresh copy)
- Don't edit the SQL file
- Paste into Supabase SQL editor
- Check that entire file is selected before run

### "SUPABASE_URL not reachable"
- Check URL format: `https://xxxxx.supabase.co`
- Verify copy-paste is complete
- Check internet connection
- Try in browser first (should show JSON)

### "Service Key is invalid"
- Copy from Supabase Settings > API (not somewhere else)
- Make sure you copied the **Service Role Key** (not Anon Key)
- Don't edit or truncate the key

### "Supabase tables don't exist"
- Check SQL editor response (should say "Success")
- Try running migration again (it's idempotent)
- Check Table Editor is showing public schema
- Refresh page if needed

### "Bot not syncing to Google Sheets"
- Check `GOOGLE_CREDENTIALS_JSON` is correct
- Verify service account email was shared to sheet
- Check service account has Editor role
- Google Sheets sync is async (wait 5-10 seconds)

---

## File Locations

| What | Path |
|------|------|
| Migration SQL | `/supabase/migrations/001-init-schema.sql` |
| Setup instructions | `/SETUP_GUIDE.md` |
| Deployment steps | `/DEPLOYMENT_CHECKLIST.md` |
| Env template | `/.env.template` |
| Validation script | `/scripts/deploy-checklist.sh` |
| Source code | `/src/` |

---

## Next Steps

1. **Read:** `SETUP_GUIDE.md` (Step 3 is the new Supabase step)
2. **Follow:** `DEPLOYMENT_CHECKLIST.md` (now has 7 steps instead of 6)
3. **Validate:** Run `./scripts/deploy-checklist.sh` before deploying
4. **Deploy:** Follow `DEPLOY_TO_RENDER.md` as before

---

## Support

**Question:** Where do I run the migration?
→ In Supabase SQL Editor. Copy the file content → Paste → Run.

**Question:** Which key should I use?
→ `SUPABASE_SERVICE_KEY` = Service Role Key (from Settings > API)
→ Not the Anon Key, not the JWT token

**Question:** Do I need to modify the migration file?
→ No, copy-paste exactly as-is. It's idempotent (safe to run multiple times).

**Question:** What if the migration fails?
→ Check the error message. Common: incorrect copy-paste. Try again with fresh copy.

---

**Status:** ✅ Supabase integration complete and documented. Ready to deploy!

See you at `DEPLOYMENT_CHECKLIST.md` for full step-by-step instructions.
