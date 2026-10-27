# Handoff: RouteFlow MacBook landing (2026-09-30, late update)

Lane: MacBook landing. Remote Control ON. Worktree for WS10: `/Users/najathakram/code/routeflow-2648` (node_modules = per-entry symlinks to routeflow-2437 EXCEPT `@routeflow/*`, which point at this worktree's own packages; pricing/scanning built here; `.husky/_` copied so pushes run pre-push verify). `routeflow-2864` = PR-C verify worktree (same overlay). `routeflow-2861` = #2861 verify (done).
Load rule (lead): ONE full verify at a time on the MacBook; M4a's verify first. Commit subjects <= 72 chars (commitlint).

## Branches (all local commits; pushes QUEUED behind M4a's verify, then one at a time)
- #2864 PR-C `feat/credit-note-error-codes` local 56ce0308f (origin 227b71199): CREDIT_NOTE_* codes + SA-608h P2034 fold. Base must retarget to master (#2801 landed 67207d9a). Needs verify exit code in the PR body.
- #2867 U1 `feat/credit-note-edit-ui` @86ceb4d5a (pushed; carries unpushed PR-C fold). Opus FAIL fixed (refusal copy, _skipOfflineQueue, notes). Needs `npm run verify` after #2864.
- #2802 `feat/2540-void-reason-tz`: merged origin/master locally (18e8959f9); diff vs master = only #2802's 5 files. Push + verify pending.
- #2851 `fix/2848-source-deleted-marker`: merged origin/master locally (75e9711bc; tree = master + own 9-file diff). Push + verify pending. Commit 2 (orders.service doors, actorId) waits for U-units #2784/#2786.
- #2870 `fix/git-env-scrub-rebuild` local cb3023678 (origin b3ff6b679): generic-runner tripwire fix + mutants l/m/n/o; PR title already <=72. Push pending.
## Next
SA-619 (platform tenancy fail-closed, DARK): test plan sent to lead, waiting for OK; then build test-first. Then SA-608g (deleteInvoice lock order, after #2851 commit 2). Apply-toast bug = B921 (coordinator). Engine sync: waiting for lead's ruling (no ~/.claude/skills/dev-pipeline on this Mac).
## Lessons to record (bookkeeping)
- A worktree that borrows another checkout's node_modules resolves @routeflow/* to the OLD packages: false test failures. Link them to the worktree's own packages and build pricing/scanning; run `prisma generate`.
- A race pin without a barrier passes sequentially; hold both callers at numbering.reserveNext.
- A merge of a squash-landed branch: use `merge -s ours` + read-tree master + apply the branch's own diff; never trust a textual auto-merge (it duplicated a controller route).
- `in` accepts inherited keys ("toString"): use hasOwnProperty for a code->copy lookup.
## Standing rules
Every push: PR body "verify: pending F2"/verify exit + sha to lead; HEAD commit carries Bookkeeping-Follow-Up: pending; never force-push, --no-verify, git stash, `git worktree remove`; owner yes (MacBook chat) still needed to remove 12 stale worktrees (#2554 5873251919).
