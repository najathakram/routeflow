# Claude Code Session Preamble

**Paste this at the top of every Claude Code prompt that touches backend code,
migrations, or scripts. One copy-paste, zero accidents.**

---

```
PRODUCTION SAFETY CONTEXT — READ BEFORE DOING ANYTHING:

  Production database: Railway Postgres (real tenant data — DO NOT TOUCH)
  Local database:      local Postgres / Docker (safe to modify freely)
  Staging database:    Railway staging service (safe to modify with backup)

  RULES FOR THIS SESSION:

  1. Do not generate any command that runs against Railway directly
     unless it is: railway run npx prisma migrate deploy
     and I have explicitly asked for a migration to be deployed.

  2. Do not modify, call, or reference these scripts in any way:
       DANGER-fresh-data-WIPES-ALL-DATA.js
       nuke-db.js
       reset-seed.js
       clear-financial-data.js
       cleanup-qa-data.js
     If test data is needed, generate a SEPARATE additive script that
     inserts new rows without deleting existing ones (INSERT ... ON CONFLICT
     DO NOTHING pattern).

  3. If you generate a migration file, output it for my review first.
     Do not generate a command that runs it. I will run it manually
     after reviewing it.

  4. If any step you are about to suggest would be dangerous on a
     production database, say so explicitly BEFORE suggesting it.
```

---

## Quick reference — safe vs dangerous commands on Railway

| Safe | Dangerous (never) |
|------|-------------------|
| `railway run npx prisma migrate deploy` | `npx prisma migrate reset` |
| `railway connect postgres` | `npx prisma db push --force-reset` |
| `git push origin master` | `node DANGER-fresh-data-*.js` |
| | `npm run seed` |

## Pre-session checklist (30 seconds)

- [ ] `cat apps/api/.env \| grep DATABASE_URL` — confirm it shows `localhost`, not `rlwy.net`
- [ ] Am I on a feature branch, not `master` directly?
- [ ] If this session touches schema: run `./apps/api/scripts/backup-production.sh` first

## When you need test data — say this instead

> "Create an **additive** seed script that inserts new test records without
> deleting or modifying any existing records. Use INSERT … ON CONFLICT DO NOTHING.
> The script must be safe to run against a database that already contains real
> tenant data."

## When you need a migration — say this instead

> "Write a **Prisma migration file** for [specific change]. Additive only —
> no DROP TABLE, no DROP COLUMN, no TRUNCATE. Output the file content for
> my review. Do not generate a command to run it."
