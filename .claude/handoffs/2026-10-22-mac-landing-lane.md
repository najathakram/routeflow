# Mac mini landing lane — handoff 2026-10-22 ~20:40Z (idle until the 10-26 08:00Z reset)

Lead = "Routeflow Lead" (Windows box). The old PC lead is retired.

## Open, awaiting review or merge (do not touch while the lead's runners hold them)
- #3614 ops-monitor D3 follow-up @887115e80: reverts, moved-back items, alarm noise, queued = pending. Needs one review.
- #3597 Dependabot @d2b442d14: lands ALONE in its own window; the lead does update-branch + CI. e2e diff vs master: no new failures.

## Unpushed (lead: keep it so until told)
- ~/code/rf-wt-opssc, branch fix/ops-sync-in-collector: 9baf398b1 + master merge 87cf4346e.
  - Runs the register and status sync inside the collector's specs pass (fixes the PC lock loss).
  - ops:test 576/577.

## Merged today
#3600, #3604, #3606, #3612. Specs register row 754 (master e2e failures, tracking only).

## Notes
- The shared compose stack (project rf-wt-dblane) is on master. My rf_b297_pg/rf_azm_redis were recreated empty.
- Worktrees holding node_modules: rf-wt-opsrt/opsls/opspt/opsdt/opsd3/opssc, rf-wt-dep3597, rf-wt-mverify. Delete the node_modules when disk is tight.
- One ops:test failure is pre-existing and macOS-only (lanes-local Windows paths).
