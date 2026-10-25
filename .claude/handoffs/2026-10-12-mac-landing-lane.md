# Handoff: Mac mini landing lane (2026-10-12)

## Standing rules (from the lane start prompt, still in force)
- Sole pusher on the Mac mini; one push at a time with NORMAL hooks; never `--no-verify`; the audited
  `SKIP_VERIFY` skip was denied by the classifier ("CI Bypass"), so fix the gate instead.
- One worktree per branch; APFS `cp -cR` of `node_modules` + package `dist/` is fine; rebuild
  `packages/{pricing,returns,scanning}` dists and run `npx prisma generate` in a fresh tree.
- Never `npx husky`; `core.hooksPath` stays at `/Users/maznahamanullah/code/routeflow/.git/husky-shim/_`.
- `git ls-remote origin <branch>` must equal the pushed full sha before reporting; full shas only from
  same-turn command output. Messages to Routeflow Lead: a sha, a verdict or a blocker, one paragraph.
- Never merge or flip visibility; never touch prod DB / CLAUDE.md / another lane's worktree; mint no bug ids.
- Every commit: `Bookkeeping-Follow-Up: pending` (or `done` for the docs PR itself) + the Co-Authored-By line.
- Heavy jobs one at a time (RAM < 90%, disk >= 10 GB); keep `rf_b297_pg` stopped when idle.

## Landed / pushed this window (all unmerged unless the Lead said otherwise)
- `feat/buyer-gate-enforce` (flip + dashboard notice + one seller-unavailable copy + home Add live); see the line below for the current head.
- Row 401 `0ab1c0034` (merged R5.2), due-column follow-up `c80027ade` (merged R5.2).
- Bookkeeping: `docs/r52-bookkeeping` (merged #3393), `docs/r381-bookkeeping` b9d7f413d (open, off master 96fc7351f).
- `feat/buyer-gate-enforce` now 478573457 (origin/train/w24-r53a merged in f3e97f006; read-only copy pin allow-list
  for `lib/seller-unavailable.ts`); rides R5.3a, env-var flip is the owner's step after deploy.
- Row 413 `fix/verify-merge-drop-get-preview` 2cd25d1e8 (GET verify-merge preview removed; queued for the next train).
- Full DB lane on train 2bcbbfc72: 242/242 green. 381 ran its own red+green.

## Branch C (state portal limits web UI), row 414: DONE, pushed
- `feat/sr-c-ui` c41e1052e1f2058dcd86b54f23b62801cfdf276b, rebased on B's `feat/sr-b-admin-bulk` 1230b1780 (B's 3 API commits
  sit underneath, so merge order is A, B, C). Web jest 748/748, tsc clean, size ratchet green, normal pre-push passed.
- Proof: Playwright at 1440 + 390 with the API MOCKED at the network layer (A unmerged then); shots in
  `local-assets/proofs/sr-c/`. Remaining check = the real-stack E2E on the A+B+C train tree.
- Open for the next lead: B's Addendum D routes (buckets, bulk-state, undo, address PATCH/minimal) are what the card
  calls; A's reorder `skipped` + 400 sentence are read as agreed; the old readiness lines other than
  `businessStateMissing` were dropped by ruling.
- `feat/buyer-gate-enforce` 4785734578dce0ad989a97b2aaeece6663f0c760 (r53a merged in); row 413
  `fix/verify-merge-drop-get-preview` 2cd25d1e8; `docs/r381-bookkeeping` b9d7f413d (open).
- Weekly usage 97%: idle; nothing assigned.

## Open / next
- Nothing assigned (Lead: stay idle unless routed; weekly usage 92%). If asked: targeted DB re-run for 381's suites on a post-merge tip.
- `docs/r51-r42-bookkeeping` (c48944b66) is carried inside the merged R5.2 bookkeeping; it needs no PR of its own.
- Known limitations told to the Lead: driver read-only banner shows only after a refused write (no
  driver-readable status); hand-rolled dialogs are outside the Modal notice slot; the shop's Add stays
  enabled by design (cart-only).

## Local state to clean when disk is needed (ask first, never another lane's tree)
- Worktrees I created: `~/code/rf-wt-bge`, `rf-wt-bge2`, `rf-wt-r401`, `rf-wt-pasd`, `rf-wt-bk52`,
  `rf-wt-bk381`, `rf-wt-vm`, `rf-wt-src`, `rf-wt-dblane` (each has a cloned `node_modules`; `npm run janitor` reports, `:apply` reclaims).
- Scratch: `/private/tmp/claude-501/push-*.sh` and `*.log`, `dblane-full.*`.

## Row 414 needsDefault + train (2026-10-13): DONE, handed to the Lead for the window
- B feat/sr-b-admin-bulk aa747d028 (SA PASS), C feat/sr-c-ui b1b3aaa52 (SA M1 fixed), train/r414-sr e459a981d
  (master a6bd2a8a6 → A ff → B 3d5b59682 → C 70189dc41 → fail-open pin). DB lane 247 suites / 1819 green
  (b1043 needs an rf_dbspec_* DB). Real-stack UX 12/12, proof local-assets/proofs/sr-414/.
- Worktrees: ~/code/rf-wt-414b (feat/sr-b-414), rf-wt-414c (feat/sr-c-414), rf-wt-414t (train/r414-sr); all npm ci'd.
- Traps hit: detached-HEAD push = FULL verify; npm ci rewrites core.hooksPath (restore the shim); seed leaves stateCode NULL.

## 2026-10-13 later: U1 + settings + perms (all pushed, awaiting SA/Lead)
- U1: VU-4b #3324 3829e9ec9 (SA PASS-WITH-NITS, nits folded); U-6 #3336 a8ea17419 FAILED -> rework for Train U2
  (M1 drop packLabel fill, M2 parentUnitId/perParent, M3 prod-capable path per B297 PR6 #3399, M4 FOR SHARE) — NOT STARTED.
- 414 train CI fix bd46f38bd (allowlist 74 -> 72); #3401 merged as d6572ca59.
- apple-ux pass: PRs #3404 c2b7a5a54, #3405 698330b53, #3406 1870d2a80 (SA passed all three).
- Settings: PR1a #3413 7e700a7e4; PR1b #3414 75ca7b606 (stacked); #3320 closed (superseded);
  folds #3416 b53bca1d9 (stacked on PR1b; Units entry gated on flag.units_settings_v1).
- Perms PR1 #3412 2eb97736a (UI half + M2 lockout + M3 structural pin) — sent to SA.
- Row 444 volumes: NOT run (permanent deletion); owner script local-assets/landing/remove-unattached-volumes-2026-10-13.sh.
- Worktrees: rf-wt-414b/414c/414t, rf-wt-u1-vu4b, rf-wt-u1-u6, rf-wt-ux, rf-wt-ux-vu4a, rf-wt-uxfix, rf-wt-uxproof,
  rf-wt-pr1a (pr1a/pr1b/folds branches), rf-wt-perms, rf-wt-perms-mob. Stack stopped; rf_b297_pg stopped.
- Proofs: local-assets/apple-ux/2026-10-13-sr-billing-hub-units/{proof,proof-pr1a,proof-pr1b,proof-perms,polish,shots}.

## 2026-10-13 evening: #3412 musts, settings restack, U-6 rework (all pushed, awaiting SA)
- Perms #3412 feat/operator-perms-pr1 6dce43017 (musts + nits + mobile own-row; carries a .prettierignore line for master's useReactivateFlow.test.tsx).
- Restack by MERGE (no force-push): PR1a 188977b2d -> PR1b 91be34c54 -> folds c32a6e2f9. M-INT1/M-INT2 + operator hub/rail tests. Lead: Units entry needs no admin gate.
- U-6 #3336 feat/u6-units-backfill 775f807db (M1-M4, DB 7/7). Parity pin to U-1 helpers still owed once U-1 lands.
- Trap: never `git stash` in a worktree (shared stack; popped another lane's stash once, recovered).
- rf_b297_pg stopped.
