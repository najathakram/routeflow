# Shared-host heavy-job slot — `scripts/heavy-slot.mjs`

Several lanes share one dev host. Three or four heavy jobs at once (verify, Docker image builds,
Playwright, DB specs) pin the CPU for hours: a verify that takes ~15 min alone took 2 h+, and tests
that pass alone timed out. The fix is scheduling, not fewer checks: **one heavy job at a time per
host**, first come first served. Nothing a push runs is removed or narrowed.

## What takes the slot (inside the script, so root `package.json` is untouched)

| Entry point                                                               | Label           |
| ------------------------------------------------------------------------- | --------------- |
| `npm run verify` → `scripts/verify-turbo.mjs`                             | `verify`        |
| `local-env.mjs` with `--build-sha` (`local:up`, `local:build`) or `--e2e` | `local:<cmd>`   |
| `scripts/local-db-specs.mjs` (`local:test:db`)                            | `local:test:db` |

Light modes (`--db`, `--smoke`, `--proof-stack` alone, `--smtp-specs`, `--db-specs`) do not wait.
A nested call (`heavy-slot run -- git push` → pre-push → verify) reuses the outer hold through
`RF_HEAVY_SLOT_TOKEN`, so it never deadlocks on itself. CI never takes the slot and prints nothing.

## Look at it

```bash
node scripts/heavy-slot.mjs status   # holder, queue positions and ages, last 5 runs (wait/held minutes)
```

A waiting job prints `heavy-slot: waiting (position k of n) — held by <label> on <branch>, pid <p>, <m> min`
on entry and once a minute. State lives in `~/.routeflow/heavy-slot/` (`slot-*.lock`, `queue/`,
`history.jsonl`, last 500 runs).

## Knobs

| Env                                      | Default                   | Meaning                                                                                                                                                           |
| ---------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RF_HEAVY_SLOTS`                         | `1`                       | concurrent heavy jobs per host                                                                                                                                    |
| `RF_HEAVY_SLOT_MAX_WAIT_MIN`             | `720`                     | total-wait backstop, then **fail closed** (exit 75, holder named, nothing ran)                                                                                    |
| `RF_HEAVY_SLOT_MAX_HOLD_MIN`             | `180`                     | a waiter gives up (exit 75) when the current holder, still heartbeating, has held the slot longer than this (wedged but alive); `status` flags it `OVER HOLD CAP` |
| `RF_HEAVY_SLOT_DIR`                      | `~/.routeflow/heavy-slot` | slot directory (never the git dir or tmpdir)                                                                                                                      |
| `RF_HEAVY_SLOT=off`                      | unset                     | run unguarded with a loud WARNING (owner/lead only)                                                                                                               |
| `JEST_MAX_WORKERS`, `VERIFY_CONCURRENCY` | unset                     | explicit values always win over the budget below                                                                                                                  |

On a non-CI host with >= 24 GB and no `JEST_MAX_WORKERS`, verify budgets
`max(2, floor(cpus × 0.75 / concurrency))` jest workers per task (14 cpus → 5) and prints one line.

A holder or waiter that dies is reclaimed automatically: dead pid, no heartbeat for 2 min, or another
host. A hard kill therefore frees the slot after about 2 minutes.

## Wrap any other heavy command

```bash
node scripts/heavy-slot.mjs run --label <x> -- <command> [args...]    # exits with the command's code
```

Until this change is on master, wrap a push from a branch that lacks it with this worktree's copy:
`node <path-to-this-worktree>/scripts/heavy-slot.mjs run --label push -- git push ...`

## Before you push

- After merging master, run `npx prisma generate` in `apps/api` (the preflight now refuses a stale
  client in seconds, before queueing). Worktrees sharing `node_modules` through junctions share ONE
  generated client, so generating in one changes it for all of them.
- After changing a shared type in `packages/types`, run `npx tsc --noEmit -p apps/web` (and mobile
  if it imports it) — a type error otherwise costs a full slot hold.

## Flake triage (a test failed under load)

1. Run **only the failing file**, alone (`npx jest <file> --maxWorkers=1`).
2. Passes alone → a **load flake**. Widen _its_ timeout in a **test-only commit** (no assertion
   change, one comment saying why) and add a tracker row. Do not re-run the whole verify hoping.
3. Fails alone → a real defect; fix it.

Never re-run blindly: each blind re-run is another full verify queued behind everyone else.
