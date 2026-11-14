# Software factory lane: brief (lead, 11-07 ~03:15Z; checked against origin/master today)

Start this lane as a **parallel session at the very start of the next lead session**, before Train 1 is routed. It runs beside the product trains and never blocks them. Owner ask 11-07: "all the improvements required for software factory ... run on a parallel lane from the beginning of next lead session."

## Lane rules
- One owner: this lane only. No other lane touches `scripts/` gates, `.github/workflows/`, `.claude/hooks/`, `tools/ops-monitor/` while it runs, except the coordinator for registry closes.
- Own worktree off master (`wt/factory-<slug>`). Never edit the main checkout. Never `janitor --apply`/`--force` (coordinator owns removal). Never touch factory-m75 or factory-jgap trees, and never hand-delete factory trees: junctions reach factory-m75 (L-180).
- Routing: Opus @high plans and reviews; Sonnet 5.5 @medium builds; Haiku @low runs mechanics. Every agent gets an explicit model and effort. At most 2 background agents, because the lead's cap of 4 is shared.
- Each item: Design Gate (future-proof), red-first test, one Opus review, T2 gate (one PASS + green CI). New gates ship **dark**, and flip to enforced only in a separate PR backed by warn-run evidence.
- Counts against the ~10 open-PR limit: at most 2 factory PRs open at once. Trailer `Bookkeeping-Follow-Up: pending`.
- Reports go to the lead only, never to the owner.

## Already done (no work)
R0-R7 merged (#3914-#3952; R3 size and R4 test-tamper run DARK in ci.yml, `continue-on-error`); janitor fix 2 #4207, Jest-cache #4218, worktrees-only #3974, fast-scan #4049, regenerable gaps #4072; wall-clock budgets #4187 (W-1128); factory-eval + fix-revert-probe scripts on master. Step 0 backups exist: `refs/archive/2026-11-06/factory-*` + `local-assets/branch-archive-2026-11-06/archive.bundle`. fix/hooks-* branches: master is ahead in every file, so they look superseded. Confirm in F7, then leave them archived.

## Open items, in build order
| # | Item | Where it is now | Done when |
|---|---|---|---|
| F1 | **Unsaved heavy-slot change** in the MAIN checkout: `scripts/lib/heavy-slot.mjs` +17/−2 (slot count read from a `slots` file, UTF-16 safe) | Uncommitted, author unknown | Copied into a factory worktree with a self-test case, PR'd or dropped on a ruling; the main checkout reverted only after the copy is pushed |
| F2 | **Scoreboard B3**: `scripts/factory-scoreboard.mjs` counted 0 merges on 11-02 with 200+ (gh `--search merged:`) | Owner yes 11-04; no commit since #3862 / R1-b 7b2d8be478 | Red test on a fixture with merges; count without search; 0 fails loudly |
| F3 | **Train cost telemetry** (R1): "no train cost measured yet" | R1-b landing rows merged; values unverified | One real train's row shows route, rounds, cost, lines; agent-log nulls gone |
| F4 | **I-160**: PR-Size-Override trailer is self-grantable | Open (INTAKE) | Override needs an owner-only label or approver comment; spec red on self-grant |
| F5 | **Enforce flips, one at a time**: R3 size, then R4 test-tamper, then R5 risk-tier | All dark | Each flip = own PR + count of warn hits over the last ~20 PRs showing it is clean; F4 lands before R3 |
| F6 | INTAKE small fixes: I-185 Verify canceled at 8-10 min; I-187 email.service CPU-timing flake (check whether #4187 covered it); I-189 size-ratchet row swap; I-191 `local:up` from a worktree needs `COMPOSE_PROJECT_NAME=routeflow` | Open since 10-28 | Each closed with a PR or "covered by #N" |
| F7 | **Lead-log guards not built**: train pre-check prints `merge-base --all` count + each member's Migration replay result; lead-relay script (owner decisions sent first); confirm the silent no-hook push guard is on master (ensure-git-hooks; #3999 class) | Promotions due: "Tier-1 money reviews run the module's FULL DB lane" 7x, "Verify before instructing" 74x | Scripts merged; the two promotions written into fleet-lead SKILL.md |
| F8 | **Ops always current**: 56 building-stale, 8 lane-silent, 2 stale incidents; status-behind-merge needs a manual sweep every time (12 swept 11-07) | Ledger PARTLY | Merge of a linked PR moves its item automatically (or a daily `rf` sweep); building-stale under 10 |
| F9 | **Code map** stale: mappedSha dc95e0ea vs HEAD, 510 files | Stale | Catch-up regen landed docs-only |
| F10 | **Self-hosted runner launcher fixes** (owner 10-30: launcher fixes first; Verify on train heads only, lead starts it) | Not started here | Launcher starts and stops cleanly; documented in the runbook |
| F11 | **Bug-swarm vs regular fixes measurement** (owner 10-22) | Six runs (#4077), no comparison | One table: cost, rounds, rework per fix, swarm vs bug-pipeline |
| F12 | **B2** Mac mini dead-man switch for public windows: install unconfirmed | Needs the Mac mini | Install confirmed by a test flip on a dry run |
| F13 | **B1** bug detail out of the repo that goes public | Waits on the owner's control-token step (Q2); 3 branches archived and stale vs master | Lead boxes Q2 first; rebuild on master after the answer |

F1-F4 and F6 are the first batch (small, parallel-safe). F5 waits for F4. F12 and F13 wait on the Mac mini and the owner. Nothing here outranks Train 1 for the shared heavy slot or DB lane.

## Start prompt for the lane (paste into start_session, context "fresh")
"You are the RouteFlow software factory lane (Windows). Read `.claude/handoffs/2026-11-07-factory-lane-brief.md`, CLAUDE.md, the fleet-lead lane rules and `.claude/lessons/LESSONS.md`. Work items F1→F13 in the brief's order under its lane rules. Verify each item's 'where it is now' against origin/master before building. Report branch, sha and body path to the lead for each PR; never to the owner."
