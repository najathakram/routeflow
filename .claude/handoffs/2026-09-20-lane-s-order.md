# Handoff — 2026-09-20 (updated ~05:00Z 09-21) · Lane S-order (PC, Sonnet builder)

Board: GitHub issue #938. Post as `[S-order@pc] EVENT — detail`. Worktree
`C:\ClaudeCode\routeflow\.claude\worktrees\rf-lane-S-order` (on `feat/s-order-11-rn-line-cards`).

## ALL WORK IS ON ORIGIN (local == origin for each)

- **#982** step 10 (typed Qty, box-aware merge, toast; ALL gated by `useOrderUiV2`; B596 placeholder) @09314c2b.
  B596 is UNPROVEN at 390 (stated in the PR body). Known limitation recorded at the merge site: merges on productId only.
- **#1121** web boxed-progress fix + unit-aware Case noun (`OrderItem.unitLabel` -> `boxLabel`) @be312d3f.
  CI green but HELD: needs Playwright 1440/768/390 (rides Mac "Train B" with #982). I sent Mac Lead the full state matrix.
- **#989** step 11 RN line card (dark) + B597 + Case noun @76dc9a09. Proof = Playwright 390 on the Expo web build.

## TOMORROW (lead: stand down tonight)

1. Split the two `turbo.json` entries (`@routeflow/web#test`, `@routeflow/web#check-types`, hash `$TURBO_ROOT$/apps/mobile/lib/**`)
   out of #989 into their own config-only PR off master (clean; reword the comment — the parity test is still only in #989);
   AFTER it lands: ONE commit on top of `feat/s-order-11-rn-line-cards` deleting those same two entries (they now live on master),
   plain fast-forward push (no force, no new PR, no merge-from-master — lint-staged prettier churn on master's docs turns 9 files
   into ~40). Verify `git diff --stat origin/master...HEAD` = exactly the 8 mobile/web-parity files. (Lead ruling: unpushed branch ->
   rebase; pushed branch -> new commit on top; NEVER a merge-from-master on these machines.)
2. Review S-scan's #1119-on-#982 resolve when the lead forwards the sha: the merged `ScanOrderScreen` props hunk must keep
   #982's `resolveCode` wrapper that clears `typedQtyRef` AND #1119's `renderPriceEditor`.
3. Respond to Train B / CI findings on #982, #1121, #989.

## Rulings I operate under

- New order UI gated by `useOrderUiV2()` = `useDeveloperMode().enabled`; `useScanV2` reads the same addon.
- Step 10 typed qty = "additive in the line's own unit"; the productId+unit re-key belongs to the picker PR (not mine).
- 5b restrictions rule editor is R-ui's. `apps/api/src/orders/orders.service.ts` is FROZEN until #1101 lands.
- Owner: Playwright + independent visual review for ALL web UI, no exemptions. No `--no-verify`, no force-push (lane guard;
  if a force is ever needed ask the lead, who asks the owner). GitHub CI is the binding gate (B637), not pre-push.

## Traps hit

- Pre-push takes 30-40 min under load; `visibility-watchdog-script.spec.ts` flakes under load (passes alone) — rerun.
- A scoped jest run leaves `.campaign/runs/<ws>.json` PARTIAL and the push is rejected: run the FULL suite first
  (`cd apps/web|mobile && npx jest --maxWorkers=2`) after any scoped run (L-179).
- The stop gate reads the HEAD commit's `Bookkeeping-Follow-Up: pending` trailer: give merge commits `-m` with the trailer.
- Python on Windows: read/write with `newline=''`; `/tmp` in Git Bash is not visible to python — use the scratchpad path.
- Coordinator adds empty "ci: retrigger" commits to my branches: `git merge origin/<branch>` before pushing, never rebase.
- `git switch` needs a `# guard:allow` first line; `git stash` is blocked.
- `stale local branch feat/s-order-5b1-restrictions-list` (3 unpushed commits) is superseded by R-ui — never push it.

## Follow-ups not done

- Legacy split-without-pack-size line still shows raw pieces in progress (web + mobile).
- Mobile `splitIntoBoxes` could use `normalizeBoxesPieces`; `unit-aware-guard.ts` comment is stale (create() honours unitLabel behind units_v1).
