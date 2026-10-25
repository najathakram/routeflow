# Lane B (Mac mini): "Snapshot restore and flag fixes", handoff 2026-09-26

Tree: `.claude/worktrees/rf-mac-f06-1291` (one tree, switched per branch; commit before switching, no stash).
Rules: verify slot from the Mac Lead ("RouteFlow Mac Lead coordination") for every push; `JEST_MAX_WORKERS=4`;
Bookkeeping-Follow-Up trailer; commit as Najath Akram <najathakram1@gmail.com>; messages only for a blocker,
a decision, a slot, or "PR ready: #N <sha>".

## Open PRs (verify shas with `gh pr view N --json headRefOid` before acting)
- #1291 (#2012 config-snapshot UI) @12213a29. Waiting: reviews, F2 Playwright. Follow-up owed: SA-386 LOW pin
  "second restore of the same snapshot is refused" (both writers).
- #2227 (#2187 proration, SA-383) @506dd1f9. SA-387 + Opus PASS; CI.
- #2280 census script (chore/2187-period-census) @18653d25. Tier 2. Nit if touched: the fail-closed case must also
  unset RAILWAY_TCP_PROXY_* / POSTGRES_*.
- #2239 (#2188 add-on row lookup, SA-385/385b) @aa553f18. The owner runs report-b2188 at landing.
- #2240 (#2189 subscribe B58 under lock, SA-389/389a) @82cccf7a.
- #2258 (#2255 Serializable retry, SA-404/404a/b/d/e): remote @bceaf3d2; LOCAL HEAD 53e9bc70 (F2's R1/R2 DB cases
  + the SA-404e comment). HOLD: push once only after Opus's re-read returns folds or "push as is".
- #2281 amendments (lead): the flip commit must FOLD N1: importPayments refuses a VOID invoice INSIDE its per-row tx,
  and case (b) asserts the payment count (today it accepts a VOID invoice holding $100). N2 (the end sweep writes by
  id outside a tx) is a separate follow-up issue. DO NOT remove the ImportService EXEMPT rows until the SA rules
  (F1): importInvoices' new-invoice branch is create-only (:960-989), so the coverage rule would go red. #2281
  lands as is only on an SA PASS at c9dce515.
- #2281 (#2262 import payments in one tx, SA-404b) @c9dce515. AFTER #2258 MERGES: merge master,
  then ONE commit that (1) drops the two ImportService EXEMPT rows and sets EXEMPT_BASELINE 0 in
  invoice-payment-writers.coverage.spec.ts; (2) replaces DB case (b) with the REVERSE race: T2 holds the invoice's
  ORDER row, voidInvoice snapshots and then blocks, importPayments commits a CASH payment ⇒ void 400 (retry exactly 1),
  not voided, payment kept. Conditions (#938): observe, don't predict (F2 records the actual red on a revert of the
  import-tx Invoice UPDATE, then green); the entry condition is proven by a barrier/log assertion, not timing; the
  retry count is EXACTLY 1 and nothing is partially written.

## #2258 push (slot reserved)
Waiting on the N2 B-id from the lead/coordinator (they file it on a master-current tree; the main checkout's registry
is stale, so filing there collided with B742 and was undone). Then: cite the id in IMPORT_WHY
(invoice-payment-writers.coverage.spec.ts), commit, and push ONCE (local HEAD 53e9bc70 + that commit).

## SA-404f follow-up: BUILT LOCALLY on `fix/sa404f-void-first`, stacked on c6ed3caf, NOT pushed
Commits: 1935794e (red pins), e12b66de (fix). Once #2258 lands, cherry-pick ONLY these two onto fresh origin/master
(never #2258's commits), re-run suites + repo-truth, then ask the Mac Lead for a slot and open the PR (base master).
N1 follows SA-404g: skip + conservation, not a 400. F2 observes and authors the real-PG void-first cases.
Rebuild rule (SA-065, the lead): FIRST measure orders.service.ts and invoices.service.ts on fresh master against
baseline+25 (#1353, #2278 and others land first). If the fix would exceed a ceiling: commit 1 = a behaviour-neutral
extraction that lowers that baseline in the same commit; commit 2 = the fix (tests alongside). F2 then observes
red on a revert and green on the fix at the pushed sha, posting both outputs.
(#2258 pushed @c6ed3caf.)

## SA-404f scope, as ruled (for reference)
- F1: recordStandalonePayment and BookkeepingService.recordPayment take (Order →) Invoice FOR UPDATE as their FIRST
  statement, re-read status under it, and refuse VOID/WRITTEN_OFF with a 400 before any payment/status write.
- F2: the cancel status write is a CAS: updateMany {id, status IN CANCELLABLE}; count 0 ⇒ 409
  ORDER_CHANGED_DURING_EDIT (B283). Observe it red on master first.
- N1: recordDeliveryPaymentInTx re-reads PAYABLE under the lock.
- Pins (real PG, void-first, named entry conditions, observe before predicting): 3 writers × void between read
  and lock ⇒ 400 / no payment / VOID; DELIVERED between the cancel's pre-check and write ⇒ 409 / stays
  DELIVERED; controls; forced 40001 ⇒ one retry. Draft:
  /private/tmp/claude-501/-Users-maznahamanullah-code-routeflow/ac0505c7-f637-40d3-aa46-6959cd459b91/scratchpad/sa404f-void-first-cases.draft.ts
- Until it lands, the residual is disclosed on the issue.

## #2281 EXEMPT-flip follow-up: BUILT LOCALLY on `fix/2262-exempt-flip` (c9dce515 + master merge cadef948), NOT pushed
SA-424 passed #2281 as is. My commits: a8b80ac7 (coverage F1(a) + flip, EXEMPT_BASELINE 0), 208fa3d4 (red pins
N1/N2/N3 + DB case (b)), d522fd1b (fix: N1 refusal under the row lock, N2 sweep CAS). Once #2281 merges,
cherry-pick ONLY these 3 onto fresh origin/master, re-run suites + repo-truth, and ask for a slot (tier 1). F2
observes DB case (b).

## R1.1 queue (deadline Oct 3; code freeze Oct 2 18Z), committed locally, ONE slot, pushes back to back
1. #2223 bug/2223-override-proration @23c97864 (red 9d73d080). SA-444/444a on 3 paths. NEED-DB F2.
2. test/a2-timeout @193b386b (tier 3).
3. #2226 test/2226-second-restore-pins @ed5cef89 (test-only, SA-386 LOW (a)).
4. #2225 test/2225-sell-ban-pins @45f1e8f7 (test + doc; F2 observes the new S1 case).
All four claimed via `node scripts/work/claim.mjs <n> --worker "Lane B · Mac mini · Snapshot restore and flag fixes"`.
Open a PR per branch (base master), then "PR ready: #N <sha>" for each.

## Also open
- #2315 (ratchet unblock, test-only) @9f8af3c2: lands first in the window.
- test/a2-timeout @193b386b (tier 3, (a2) case 60 s timeout): queued for a slot after F2's #1271 image build.

## Notes
- The pre-push hook includes the size ratchet (repo-truth lane): check `npm run test:repo-truth` after spec growth.
  Never raise a baseline.
- Bookkeeping nit: proration.service.ts :161-164's comment still says the window is ~one month (after #2227).
- #2255 isn't on Project #3: the gh token lacks read:project (the owner runs `gh auth refresh -s read:project`).
