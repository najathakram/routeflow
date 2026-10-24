# Lead rotation card — 2026-09-29 05:10Z (READ FIRST; you are "Routeflow Lead", Opus 5.5 @ medium, PC)

You are the decider/router, never a builder. The owner is AWAY until ~13:00Z and talks only to you. The board of record is #2554 (verdicts, SA rulings, landings); the work board is Project #3. This rotation is to save tokens (the old context was 354K; the owner-approved rotation point is ~200K).

## Standing owner orders (verbatim sources are in memory: project_owner_usage_wind_down_ladder_2026-09-29, project_owner_rulings_2026-09-29_scan_hybrid, owner-ruling-fleet-strategy/sonnet55-opus55, feedback_test_first_planning)
- "use this time 100% … get R1.1 and all the additional work I asked you for today to life." Merge reviewed PRs, review done PRs, keep lanes busy, balance the 3 machines, proactively unblock stuck lanes (never launder permissions: a classifier/prompt block is the owner's).
- Keep rf-work pages, Plane (only via plane:apply/sync) and the work board current. Clean up merged worktrees/branches (bookkeeping lane does it via janitor).
- Lanes stay terse: no chat between tool calls, ≤1 line at turn end, milestone-only ≤3-line messages. The SA writes full rulings on #2554/RULINGS.md.
- Weekly limit ladder (get_usage "Weekly · all models"; 59% at 05:02Z): 90% → all sessions update handoffs; 95% → again, nothing new starts, check usage every 10 min; 98% → write the next-lead prompt; 99% → stop everything, review the cards, confirm the repo is PRIVATE with no window open. Below 95%, check every 40 min (re-arm a background `sleep 2400` checkpoint that prints visibility, master and open PR heads).
- Windows authorized until 12:30Z (a watchdog each time, private as a finally). Replaced PRs: "Close with evidence" (patch-id/tree posted first).
- Routing: builders Sonnet 5.5 @ medium; every review is Opus (a subagent, model opus): medium routine, high tier 1. Plans are Opus @ high, test-first. Lanes use a fresh Sonnet subagent per ticket; the pre-push hook is the only full verify; build ahead; schema-freeze commit 1 for migrations.
- NEW (owner ~05:15Z): the hybrid shell outranks old-native-screen fixes. No new work on old native screens. Scan rule = SA-580 (distinct codes add their level; a shared code adds a BOX; buyer surfaces keep the product default unit, SA-580a).

## Addresses (SendMessage `to`)
- PC: "RouteFlow Lane U-po [0a6508]", "RouteFlow Lane F prover [8ff43d]", "Native lanes P0 kit [d8637a]" (= N-kit), "Native lanes buyer screens [9d6c94]" (= N-buyer), "RouteFlow Lane salvage [0ae9bf]", "RouteFlow MacBook bookkeeping [a5c851]" (a PC session despite its name).
- Mac mini: "RouteFlow Mac Lead coordination [6109f8]" (relays to Lane B [34a787], U-units [5a50c8], F2 [09638a], coordinator [82c2ca]), "RouteFlow SA (architect) [432a93]". Their replies arrive from bridge: addresses.
- MacBook (the owner is opening them): "RouteFlow MacBook landing" (push #2695 part 2), "RouteFlow MacBook M4a" (build M4a-0 → M4a-1; point it at SA-578 5883901817, SA-580 5883954773, SA-580a 5883967133 and the plan on #2717 comment 5883819120).

## Lanes → current tickets
- Lane B (Mac): M2 recipes. c1 2e59d820 FAILED SA-575 (missing CREATE TYPE RecipeStatus) → regenerate via migrate diff plus an enum/CREATE TYPE shape test; F2 replays; the SA re-pins; then the service code. SA-574 + SA-579 binding (RecipeComponent immutable once non-DRAFT).
- U-units (Mac): 5 rebases pushed (#2287, #2134, #1302, #2102, #1229) → pricing helpers (plan #2717 comment 5883720827 + SA-574: H2 = linear roundMoney(S×c/P)) → M3 (SA-579).
- F2 (Mac): M2 c1 replays; tier-1 proofs.
- Coordinator (Mac): window open since 04:13Z, watchdog to 07:13Z. Landed #2729, #2066, #2725. Queue: #2241, #2679, #2733 (M1, fully gated, migration done), #2638, #2481, #2672, #2616, #2484, #2131, #1328, #2287, #2134, #1302, #2664 (needs CI on the current master ref, SA-577); then docs #2216, #2098, #1351, #2731, #2732.
- N-kit (PC): FIRST the app.json 1.1.1 → 1.2.0 bump plus a pin test (OTA crash hazard; OTA HOLD posted on #2554 5883969619), then push the #2653 API. EAS owner checklist: local-assets/handoff/2026-09-29-eas-hybrid-build.md.
- N-buyer (PC): the #2737 FAIL fold (my verdict on #2554 5883946279: reuse scrubbedGitEnv everywhere, a per-spawn tripwire, a count > 0 assertion) → #2653 v2 (5f479259; close #2690 with patch-id evidence) → the #2735 fold → the #2486 Apple folds (f997833) → B893.
- U-po (PC): #2113 PR2 → the #2678 SA-551a fold (41fd296) → rebuild #2620 onto #2678 → #2734.
- salvage (PC): #2696(c) push → #2185 merge-master (B858/B859) → #2190 ($0 importer) if not covered → #2723 → ticket cards.
- F-prover (PC): B894 fix per SA-576 (branch fix/b894-prorate-monotone @5f446f1c9 in rf-b894): retarget the red spec to additivity; LINEAR only in inline-returns-pricing.ts:274 + regulated-ledger.service.ts:102; file the invoice non-monotone as its own B-id → then db-lane.mjs → lead-sweep v1 (rf-lead-sweep, chore/lead-sweep 9016f48fc). The stale uncommitted copy in rf-sa574 needs cleanup later.
- bookkeeping (PC): docs follow-ups after landings, rf-work, Plane, work:reconcile, janitor.

## Reviews in flight / owed by the lead (Opus subagents)
- In flight at rotation: #2102 @a7ffeb03 + #1229 @472ea4be merge deltas. If the result is lost, re-run: `git show --remerge-diff`, check both intents, post on #2554, tell the Mac Lead.
- Posted PASS today: #2733 @96c57dba, #2481 @2c871d0b, #2287 @b2c8bc12, #2134 @7d79e64f, #1302 @312c942c. FAIL: #2737 @2679e39c.
- Next as they arrive: M2 c1/full, helpers, B894, #2737 fold, #2653 pieces, the 1.2.0 bump, #2185, #2678/#2620, #2696(c), M4a-0.

## Plans (all saved; the PC copy is under local-assets/plans/2026-09-29/, and the #2717 comments are readable from the Mac)
pricing-helpers 5883720827 · M2 5883721447 · M3 5883818735 · M4a 5883819120 · lead-sweep/ticket-cards/db-lane .plan.md · pr-triage.md.

## Owner return packet
local-assets/handoff/2026-09-29-owner-return.md: keep it current (questions, commands, held decisions).

## Machine load
PC ~8 GB free, CPU 100% (the RAM gate queues pushes). The Mac mini has room for one push-verify at a time. No cloud (no budget).
