# Shared-host heavy-job slot — `scripts/heavy-slot.mjs`

Several lanes share one dev host. Three or four heavy jobs at once (verify, Docker image builds,
Playwright, DB specs) pin the CPU for hours: a verify that takes ~15 min alone took 2 h+, and tests
that pass alone timed out. The fix is scheduling, not fewer checks: **one heavy job at a time per
host**, first come first served. The slot itself removes and narrows nothing; what a feature-branch
push runs was narrowed separately by the owner ruling in "Fast local check" below.

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

## Fast local check (owner 2026-10-10)

Ruling: **fast local check, full in CI.** A feature-branch `git push` no longer runs the whole Jest
suite of the affected workspaces; the FULL suite runs in CI on every train/PR before anything merges,
and CI is the authority. The accepted cost is that a broken unrelated test can surface at train time
instead of at push. Target: a few minutes (about 3-8) per push instead of the 26-45 minute full holds.

**What a fast push runs** (the hook prints `FAST VERIFY (owner 2026-10-10): ...`; it is still ONE heavy-slot hold):

- `check-types` + `lint` for the affected workspaces, exactly as before (`AFFECTED SCOPE: ...`).
- Jest only for tests **related to the changed files**: `--changedSince=<merge-base with origin/master>`
  (plus `--passWithNoTests`, so a workspace with no related test passes).
- The two always-run tripwires stay FULL: every `@routeflow/pricing` test and api `test:repo-truth`
  (the structural pins, size ratchet included).
- The Prisma freshness preflight is unchanged (seconds, before the slot is taken).
- `campaign-check` still validates the ledger (shape, tiers, states, evidence, build-plan rows) but
  defers the report-coverage enforcement ("a test titled REG-B### in the jest report") to CI, because a
  related-only run leaves partial reports by design. It prints
  `campaign-check: report coverage deferred to CI (fast verify)`.

**What is NOT fast** (byte-identical to before): CI, master/main/detached HEAD, `FULL_VERIFY=1`, and a
bare `npm run verify` typed by hand (fast mode is switched on by the pre-push hook, below).

**How it is switched:** `.husky/pre-push` asks `node scripts/verify-mode.mjs` (fast = not CI, not
`FULL_VERIFY=1`, not master/detached, merge-base with `origin/master` computable), exports
`RF_VERIFY_MODE=fast` on `fast` (and unsets it otherwise). That one variable is what `verify-turbo.mjs`,
`decideScope` (no stale-report workspaces pulled in) and `campaign-check.mjs` read; CI never sets it, and
the readers ignore it under `CI` or `FULL_VERIFY=1`. If the merge-base cannot be computed the run falls
back to the FULL plan, loudly. To emulate by hand: `RF_VERIFY_MODE=fast npm run verify`.

**Verified-tree marker:** the `.git/rf-verified` key carries the mode (`<tree>:fast`, `<tree>:affected`,
bare `<tree>` for `FULL_VERIFY=1`), so a fast pass never lets a later `FULL_VERIFY=1` push skip, and a
full pass does not skip a fast one.

**Run everything locally:** `FULL_VERIFY=1 git push ...` (or `FULL_VERIFY=1 npm run verify`).
**Money and security branches should run `FULL_VERIFY=1` before a train when convenient**: Jest's
related-test selection follows imports it can see inside each workspace, so a change in a shared
package (for example `packages/pricing`) is covered by that package's own full run but may not select
api/web/mobile tests that reach it only through the workspace link, and specs that read repo files by
path (scripts, hooks) are not "related" to those files. CI catches these on the train; a local full run
catches them earlier.
