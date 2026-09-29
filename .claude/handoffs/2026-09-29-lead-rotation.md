# Lead rotation card — 2026-09-29 03:16Z (read this first; everything else is on #2554)

**Why a new session:** owner-approved rollout step 1 (plan usage: Weekly·all-models 53% at ~19 h; the old lead context was 579K). Memory: `project_owner_ruling_fleet_strategy_2026-09-29`, `project_owner_ruling_sonnet55_opus55_routing_2026-09-29`. Seat: Opus 5.5 @ medium; rotate again at ~200K.

## State at 03:16Z
- master `faf46759`, repo PRIVATE. The owner's window authorization ran to 03:00Z and has EXPIRED; ask before any window.
- **FLEET HELD**: owner, ~02:50Z, "hold the fleet". Resume condition: the owner's 03:10Z question-box choice "Rollout in that order (Recommended)", whose text says "Rotate my session first, then the sweeper and loop, ticket cards, the two check scripts, the ledger fix; the fleet resumes with small sessions." Quote it verbatim in the resume message. Resume only after this rotation. Rule: only the owner lifts a pause, quoted.
- PC `.git/config` was corrupted at 23:59Z by a spec fixture (core.bare=true, a fixture identity) and REPAIRED by the owner at ~02:31Z (verified). Root-cause fix = N-buyer's first task.
- The Mac sessions (Mac Lead, SA, coordinator, F2, U-units, Lane B) DROPPED after the Claude update and are unreachable. Owner must reconnect. The Mac's skill copies still carry the OLD routing; sync them to the PC's 2026-09-29 versions.
- The old LEAD SWEEP cron is GONE (CronList and scheduled tasks both empty). The sweeper replaces it (rollout step 2).

## PC lanes (all Sonnet 5.5 @ medium now; F-prover switched from Opus)
- N-kit `local_1c2c7ba2…`: #2653 API local `0e10090b4`; the specs that failed on the bare repo are green again. Queue the push (RAM gate). Tier 1: SA + Opus + F2. Owner steps at gate: HANDOFF_TOKEN_SECRET, backup, prod-migrate.
- N-buyer `local_5e828db6…`: (1) branch `fix/stop-gates-spec-git-env-scrub`: red-first GIT_* scrub + tripwire; (2) #2653 v2 `5f479259` (new PR vs master, close #2690, patch-ids equal per commit → lead carry check); (3) B893 `803e0d0f` stacked on #2735.
- U-po `local_c7628450…`: #2113 PR2 `e37e1672` unpushed; #2734 after #2066 lands.
- salvage `local_be5adfbe…`: #2696(c) `d8a477c4` local; merge master, push, then #2723 (SA-571).
- MacBook bookkeeping (PC) `local_a4bddb54…`: the next docs PR after the landings.
- F-prover `local_c227b354…`: idle. Revert-red/races/captures only (CI owns the full DB lane).

## PRs
- Ready except CI (next window, owner OK needed): #2729 `73941996`, #2066 `01506d92`, #2725 `c9568dfa` (copy nit "Cancel order ?" → follow-up ticket, not filed yet), #2241 `63018bf8`, #2679 `46352e40` (F2 green 5880887385; confirm lead + SA verdicts at this sha), docs #2731 `33ae9eec`, #2732 `72d8eb62`. #2722 is stacked on #2725 (U-units).
- Needs lead review: #2735 B892 `4a0a6a82` (tier 2, not launched). #2733 M1 `da0fcaad`: F2 real-PG PASS (5881402535); lead Opus re-review at this sha NOT done; SA calls (a) P2002 mapper for the race loser, (b) tray pin, pending; owner migration BEFORE merge.

## Owner queue (batch these)
1. The window OK.
2. v13 publish: steps 1/1b read-only (commands on #2554 5879634832, verified against b342be1a); then backup and publish after the paying-on-LITE acknowledgement.
3. The b294 read-only dry run.
4. Reopen "RouteFlow MacBook landing" (the #2695 PR-2 commits exist only there).
5. Reconnect the Mac sessions.

## Rollout (owner-approved order)
1. This rotation (DONE by opening the new session).
2. `lead-sweep.mjs` (delta-only) + a Sonnet 5.5 @ low sweeper under `/loop`.
3. Branch-keyed ticket cards + pin-facts/orient load the card for the current branch + a stale-card guard.
4. `db-lane.mjs` (transitive) + a scoped verify with the cross-workspace guards.
5. Ledger dedupe (+ the closeout --no-usage fix, in session "Fix closeout.mjs false true-telemetry…").
Then: pc-slot RAM/Docker queue, `/lead-review`, owner queue. Each: Sonnet builds, Opus reviews, self-test.

Done tonight: dev-pipeline/bug-pipeline/model-routing moved to Opus plans + reviews every task, Sonnet 5.5 builds (Opus review PASS-with-nits, folds done, self-tests green).
