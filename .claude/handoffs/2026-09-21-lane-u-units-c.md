# Handoff — Lane U-units (PC, Sonnet) — 2026-09-21 ~02:20Z (supersedes -b)

Board #938 (`[U-units@pc] EVENT — detail`). Worktree `C:/ClaudeCode/routeflow/.claude/worktrees/rf-lane-U-units`
(cd INTO it as its own call before `git checkout -b`; the guard blocks bare `checkout <ref>`; use a NEW local branch name).

## On origin / merged

#1090 (5888/5905 at merge), #1082, #1086, #1095, #1049, #1074, #993, #1123 (B606), #951 head 5378feef (page.tsx 2959/2967,
"Pre-selected on staff orders", proof requested from the Mac train). #1132 = one-file db spec off master (1c6b1b82; NEVER
executed against Postgres — needs a prover's `npm run local:test:db`; carries a verbatim copy of loadUnitLadders + dated TODO).

## LOCAL ONLY (nothing pushed, push order is the lead's: he says "go")

- **#1101 rebuilt**: branch `feat/u-invoice-create-unit-h` (== -g) = origin/master f3f8dab4 + ONE commit 5ea35f04, 9 API files, +449/-12,
  0 docs files. orders.service.ts 5905 = master (zero lines); invoices.service.ts 6389 (baseline 6390, cap 6415). Local: api tsc 0,
  ratchet 16/16, orders+invoices+products jest 65 suites/1618. **Force-push over feat/u-invoice-create-unit (f43b13d5) is BLOCKED by
  my guard (needs the USER's explicit confirmation; a peer's OK does not count; never GUARD_ALLOW).** Plan = option (b): forced
  `npx turbo run test --force --filter=@routeflow/api` (unpiped, check exit) THEN plain `git push -u origin
feat/u-invoice-create-unit-h:feat/u-invoice-create-unit-g`, read git's output, verify origin == 5ea35f04, open a NEW PR against
  master (PR body: put unit-line-writers.ast.spec.ts +4/-2 INVENTORY-row hunk first), close #1101 with a pointer. Post the sha to
  the coordinator only after origin agrees. Lead's wait: do NOT start the push (30 min hook) until "go".
- **5a+5b (clean)**: branch `feat/u-picker-5b-clean` = #951 head 5378feef + 83a59695 (5a UnitPicker/unit-options) + 83bdfeaf (5b:
  OrderLineUnitPicker + order-line-unit.ts + LineItemRow slot + CreateOrderModal wiring, 5 modal tests incl. the productId+unit
  re-key). 11 files, 0 docs, 126 web tests green. Stacked on #951 (unit hooks live only there) — rebase after #951 squashes;
  PR would be >400 lines (~+1200 incl. 5a, tests ~60%); split 5a/5b if the lead wants ≤400. #1119 rewrites renderLine in the
  same file (my edit there = ONE added prop). The OLD `feat/u-picker-5b` / `feat/u-picker-base` carry lint-staged-polluted merge
  commits: never push them.
- **5c (invoices/new)**: NOT started in code; design done. Wire in place (no prefactor, no ratchet on that file). Manual "Other
  charge" path ONLY (basis "standalone"): "New sale" (basis "newSale") goes POST /orders/sell — no picker there. Unit line = plain
  qty (count) + per-UNIT unitPrice, payload `{productId, qty, unitPrice, unitLabel}` NO boxes/pieces (invoice-unit-line.ts contract);
  the page's existing "Case | Unit sell-by" toggle (sellBy) is the PACK's qty mode — different thing, hide it for unit lines.
  update() refuses a unit (4c-2 skipped) -> after the first draft save (currentDraftId) the picker must be hidden and existing
  unit lines must fail closed (carry unitLabel through so the server refuses; never silently convert to a pack line). MarginHint
  must get cost per UNIT (pack cost x factor/upb). Reuse OrderLineUnitPicker/applyLineUnit (make them generic first). Needs PROOF-REQ.

## Traps (each cost a cycle tonight)

- **lint-staged prettier pollution**: committing a MERGE FROM MASTER runs prettier over master's unformatted docs
  (.claude/code-map/_, lessons/ARCHIVE.md, B_.md) and bakes them into the merge commit. Check `git diff --name-only origin/master...HEAD`
  before any push; rebuild as one commit on master (`git restore --source=<branch> --staged --worktree -- <paths>`). Lead relayed to coordinator.
- Commitlint: body/footers ≤100 chars/line, use `-F file` and `npx commitlint --edit file` first; a rejected commit looks like success in `| tail`.
- Commit hooks on a 464-file merge: ~10 min (check-staged-file-size); pre-push verify 30-50 min under load; never pipe a gate inside `&&`.
- Stop hook "command line too long" = merge commit not yet landed (huge file list), not a real format failure. Never `npm run format`.
- Two-dot `git diff origin/master..branch` lies when the branch is behind; use three-dot.
- Read tool: worktree paths only. Background job + Monitor `until git log | grep <NEW subject>`.

## Lesson candidates (bookkeeping PR owed)

DTO field shared by create+update opens update unless closed in the same PR · db spec outside tsconfig/eslint is gated only by its own
lane: pin claims with negative halves · client picker pinned to the server resolver by an agreement spec · a stale held value must be
reset via onChange, never masked · lint-staged reformats master's docs into merge commits · B606 forward-guard framing.
