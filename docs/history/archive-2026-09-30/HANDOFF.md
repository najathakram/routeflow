# HANDOFF — improvements program (`docs/IMPROVEMENTS.md`, 11 items) — CLOSED OUT

**Final state as of 2026-09-06 01:45Z.** Originally written 2026-09-03; this rewrite records the
finished program. All 11 numbered items in `docs/IMPROVEMENTS.md` are **LIVE** on `master`
(`17e81c2c`). New work should read `docs/IMPROVEMENTS.md` and the memory index rather than this
file's old session-bootstrap section — that section is retired along with the program.

---

## §1 Owner rulings in force — still binding on the follow-up work in §3

- **(a) Fable 5.1 is the brain and hands-off.** Every read / edit / test / command delegates to
  **Sonnet** (volume, `medium`) or **Opus** (`high`: reviews, and HIGH-risk money / auth / tenancy
  / schema edits). Explicit `model` + `effort` on every agent call — no trivial-edit exception.
- **(b) LIGHT LOOP for light work** (`~/.claude/skills/dev-pipeline/references/LIGHT-LOOP.md`):
  Sonnet builds → one Opus refute-first review → Fable plans every fix (visible at the fix level,
  never skipped) → Opus executes HIGH-risk / Sonnet writes → one scoped Opus re-check.
- **(c) Combine ship cycles only where a plan says to** — don't invent new combinations.
- **(d) Execute lists in the owner's order.** A dependency swap is a question, not a decision.
- **(e) Capacity:** ≤ 4 background agents, ≤ **1** engine at a time (two engines on this host
  tripled every Jest run), **one** full `verify` per PR at push (the pre-push hook runs it), scoped
  suites during fix rounds.
- **(f) Every agent brief starts with:** "foreground commands only (`timeout: 600000`); never end
  your turn with a command running; never pipe a gate through `| tail`."
- **(g) Never leave the repo public.** Flip private as a `finally`, only after Railway shows
  **`BUILDING`** (never `INITIALIZING`), and read visibility back. **One PR per public window** —
  never stack a second ship inside the same flip.
- **(h) Test tenants only** — `test` locally; prod smoke uses the script's default tenant
  (`test` 401s in prod).
- **(i) Verify worktree ownership before touching one.** `rf-imp-E` and whichever worktree is
  building the follow-up PR (§3.a) may be LIVE — check ListAgents + the last commit/mtime first;
  message the owner rather than stash/checkout/install into a session that's still running.

---

## §2 State per item — ALL 11 LIVE

| Item(s)                                                                                                                    | PR / commit                               | Key proof                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PR-1 — 3A** boot-DDL retirement + drift gate                                                                             | **#608** `e39bf9db`                       | prod schema drift: NO DRIFT                                                                                                                                                                                                                                                                                                     |
| **PR-2 — 2a** advisory lock + **Wave D** (5a+5b, 6b+6a, 4+7, 8, 11)                                                        | **#609** `f60bd27c`, 2026-09-04 14:41Z    | PDC 9/9 on `test`; prod drift NO DRIFT; public window 14:33–14:42Z under the watchdog (L-057)                                                                                                                                                                                                                                   |
| **E2E-guard bug fix** (`deployment_status` 403 read as a sha, fail-open)                                                   | **#610** `a5be8626`, 2026-09-04 21:36:57Z | bug-pipeline, bugfix mode, 29 agents; guard now fails loud and the e2e job carries `deployments:read`                                                                                                                                                                                                                           |
| **PR-4 — 1** `@routeflow/pricing` package + **Wave B′** (3B+9+P4+throttle knob) + repo-truth lane + web local-lane CSP fix | **#613** `22372911`, 2026-09-05 04:05:03Z | PDC 9/9 on `e2e-routeflow`; prod drift NO DRIFT; E2E `33943737313` — 115 passed / 1 flaky / 26 skipped / 0 failed                                                                                                                                                                                                               |
| **Wave E — 10a** schema folder split + **10b** shared enums/DTOs                                                           | **#621** `60d10e66`                       | prod schema drift NO DRIFT through the schema-folder move; E2E `33990397654` — 130 passed / 0 failed / 26 skipped                                                                                                                                                                                                               |
| **2b** cron leader lock                                                                                                    | **#623** `1ebd4f54`                       | cron exactly-once proven (DB lane + prod tick log — no E2E coverage needed for a background cron)                                                                                                                                                                                                                               |
| **Close-out** (Opus review fixes over the whole program)                                                                   | **#626** `17e81c2c`                       | watchdog bounded + leaves a FAILED marker on timeout; repo-truth lane + turbo inputs hardened; enum-parity tripwire added; web vendor-bills surfaces OVERDUE; backfill tool `apps/api/scripts/backfill-legacy-tenant-ids.mjs` (cascades `RouteRun`); lessons L-077/L-078; E2E `34003022013` — 129 passed / 1 flaky / 26 skipped |

`post-deploy-check` came back green against prod after every row above.

---

## §3 What remains, in order

**(a) Follow-up PR `feat/legacy-orphan-users-and-ocr-review` — IN BUILD.** Adds a deactivate-mode
for NULL-tenant orphan users (owner-run, not automatic); the OCR add-on-gate registry row carries
`reviewBy: 2027-03-31`; an unattended `--only-test-tenants` + `--confirm` path covers the
test-tenant rows without a human prompt.

**(b) Wiped-volume local rebuild proof — DEFERRED to 2026-09-06 morning**, at the lead session's
direction. Not a blocker: every landed PR above already has a prod proof.

**(c) Branch hygiene** — execute `local-assets/handoff/2026-09-03/branch-hygiene-plan.md`:
`rf-2b` is retired; `rf-imp-03` / `rf-imp-04` are next; `rf-imp-E` waits until the follow-up PR in
(a) lands; the plan's owner-decision list D still needs a call before the remainder prune.

**(d) Owner decisions still open:**

- NULL-tenant rows, full picture: 16 tables / 12,357 rows, a mix of structural and legacy rows.
  The 7 repairable rows all live in a `ux-audit-*` test tenant; the one credit-note duplicate is
  left as-is; the 3 orphan `TENANT_ADMIN` users route through the follow-up PR's deactivate mode.
- OCR add-on gate stays dark — flipping it today would deny 2 live tenants their current access.

---

## §4 Traps learned — read before touching anything

- **Lessons ids collide silently across sections on rebase.** Run `node scripts/validate-lessons.mjs`
  after EVERY rebase, not just before a commit. The register sits at **40/40** — archive a
  superseded/aged entry to `ARCHIVE.md` in the SAME commit as any new one, or the append fails.
- **Turbo's cache replay skips the campaign reporter.** Before any push from a worktree,
  regenerate `.campaign/runs/*.json` with a direct `npm test -w <app>` run — a cached
  `turbo run test` leaves stale run files and reds `campaign-check` for the wrong reason
  (L-009/L-010).
- **A 5 s Jest timeout in a spec touching a newly-wrapped method is a missing boundary mock, not
  flake.** Isolate and fix it before re-pushing; a quiet-host retry that happens to go green is
  not a diagnosis.
- **`railway run --service postgres` injects no `DATABASE_URL`** (what it does inject is an
  internal host). Scripts resolve the TCP-proxy URL themselves via
  `apps/api/scripts/lib/railway-db-url.mjs`, the way `prod-migrate.mjs` does.
- **One PR per public window.** Never stack a second ship inside the same visibility flip.
- **The classifier blocks a CHAINED `gh pr merge`** in autonomous runs — run the merge standalone,
  never piped after another command.
- **`merge:` is not a commitlint type.** Use one of
  `feat|fix|test|ci|refactor|docs|chore|perf|revert|build|style`.
- **Two engines on one host ⇒ 529 deaths + 3× slower tests.** One engine at a time.
- **`npm run verify` is red at Baseline whenever turbo replays `test` from cache.** Force it:
  `node scripts/validate-lock-edges.mjs && node scripts/validate-lessons.mjs && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs --self-test && node .claude/skills/bug-hunt/scripts/scan-signatures.mjs && npx turbo run check-types lint test --concurrency=2 --force && node scripts/campaign-check.mjs`
- **Windows:** npm scripts run under `cmd.exe`; Jest `<rootDir>` globs break under
  `.claude\worktrees`.
- **`post-deploy-check` in prod uses the script's default tenant** — `SMOKE_TENANT_SLUG=test` is
  the LOCAL seed tenant and 401s in prod.
- **Start `scripts/visibility-watchdog.mjs` detached BEFORE any public flip.** A session restart
  mid-flip once left the repo public ~6.5 h with nothing watching it (L-057); the watchdog is now
  bounded and leaves a FAILED marker on timeout instead of silently expiring.
- **Jest's transform cache in `%TEMP%/jest` is shared across worktrees and sessions** — a
  concurrent run can corrupt an entry (`UNKNOWN: unknown error, read`). Run
  `npx jest --clearCache` per workspace before a push on a multi-session box.

---

## §5 Follow-ons — recorded in `docs/IMPROVEMENTS.md`, NOT part of this program

- Postgres concurrent-query pairs that need a shared client/transaction.
- A tenancy `select` gap (a query missing its tenant scope).
- An item-edit lock race.
- `getTierPrice` widening.
- ~43 remaining hand-mirrored Prisma enums (Wave E's 10b closed a subset only).
- A `StockLot` rule to formalize.

---

No client identifiers, tenant UUIDs, or slugs outside the approved test-tenant patterns appear
above.
