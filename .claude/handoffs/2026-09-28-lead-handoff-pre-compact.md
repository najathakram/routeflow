# Lead handoff: 2026-09-28 ~04:00Z (pre-compact snapshot)

The owner is BACK and active. Board = #2554. Windows are renewed 12h from ~03:25Z. The full history is in 2026-09-27-lead-handoff.md §9.

## Owner decisions (03:25Z, verbatim on #2554 5862783064)
- #2417's lane is released (label removed); MacBook built #2070 → PR #2632, then #2612.
- Onboarding GO: **060000 APPLIED, NO DRIFT** (owner run, #2554 5862845842). ONBOARDING_TOKEN_SECRET is set; the Railway redeploy reached SUCCESS.
- Owner ran xcode-select + license accept on the Mac mini and confirmed Expo Go in F2's own chat. F2 is capturing #2592/#2606.
- Policies approved: the sweep is enforced only after the owner sees the counts; VOID blocks hard-delete (#2628); cleanup-imported disabled with a 409 (#2629, U-units, SA-531); LOST intake files purged at 90d (#2630).
- read:project is added on the Mac mini + MacBook, so all 3 machines can read Project #3.

## Now
- **#2425:** the cloud B562 builder is re-merging (a no-bare-cron conflict with #2611; SA-443c: 21 sites/names incl. onboarding.refreshAutoChecks). Then the SA plus lead re-pin, and it lands FIRST. Then the owner runs **070000** from `~/code/rf-prod-migrate-2431` (at #2431 4cfc5774; migrations byte-identical). The command shape is the same as 060000, with `-2431` and `pre-2431`.
- The #2215 page-export trap blocks PC pushes. S-order is extending #2215 (all page.tsx non-contract exports + a guard spec) as its top priority; N-kit's #2332b is held for it.
- Opus is running: #2633 (#2514). Posted: #2632 PASS-with-nits (follow-up #2634 filed), #2624 PASS (F-prover proof owed), #2621, #2618, #2620/#2622/#2625/#2627, #2626, #2603 carry.
- #2241 was rolled (spec-provider fold needed, U-po); #2185 comes after #2241 plus 2 folds.
- Branch cleanup: pass 1 found 0 safe (117 branches: 64 open-PR, 10 closed-unmerged, 40 no-PR-unique). The tree-based pass 2 was running → scratchpad branch-cleanup-2.md. The owner deletes; the lead gives the command.
- Pending owner: 070000 (after #2425 lands); the branch cleanup list; the overdue sweep counts.
