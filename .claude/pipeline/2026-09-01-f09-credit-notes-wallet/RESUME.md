# RESUME — F09 credit-notes wallet integrity (checkpoint before account switch)

Checkpoint written: 2026-09-06 ~04:30Z
Worktree: `C:\ClaudeCode\routeflow\.claude\worktrees\rf-F09`
Branch: `fix/F09-credit-notes-wallet`
Head after checkpoint commit: **see `git log -1` — the checkpoint commit `chore(f09): checkpoint before account switch`, parent `9c719827` (on master `d12203a3`)**
Workflow run: `wf_26c82331-3b7` (bug-pipeline, mode `bugfix`, scale `major`)
Run dir: `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/`
Journal: `C:\Users\nakram\.claude\projects\C--ClaudeCode-routeflow\23bd9208-6bf4-4ee7-b501-9dcabbd4e544\subagents\workflows\wf_26c82331-3b7\journal.jsonl`

## Artifacts present (ls of run dir)

- `discovery.md`, `spec.md`, `test-plan.md` — early planning (Sep 1)
- `cause-brief.md`, `refutation.md`, `cause-ruling.md` — Opus refutation round + Fable ruling
- `bug-test-plan.md` — the authored repro-first test plan (T1-T14 across gate + pins files)
- `build-plan.md` — P1-P8 package plan
- `pipeline-args.json` — **copied in this checkpoint** from
  `C:\Users\nakram\AppData\Local\Temp\claude\C--ClaudeCode-routeflow\23bd9208-6bf4-4ee7-b501-9dcabbd4e544\scratchpad\f09-args.json`
  (was never previously saved into the run dir). Contains radiusFiles, siblingPatterns,
  testPackages, packages P1-P8, redGate command, verifyCommands (perRound/final), and the
  mutationProbe targets (credit-notes.service.ts / invoices.service.ts, both `revertFix: true`).

## Stage reached

1. **Baseline** — done. (Confirm no excluded commands by reading `git diff d12203a3..9c719827`
   in this worktree before trusting it — the facts handed to this checkpoint session flagged
   "1 excluded command?" as unresolved; re-derive from the baseline log/build-plan §0 if present,
   don't assume.)
2. **Tests authored** — done. Both spec files edited:
   `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts` (gate, T1/T2/T5/T6/T7/T9/T10/T12
   per remediation — T12 was moved into this file, see below) and
   `apps/api/src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts` (pins, T3/T3b/T4/T7b/T8x2/T11).
3. **Red-gate audited TWICE** — `properlyRed:false` both times. See table below.
4. **One fix round** (8 fixes) applied against the STRUCTURAL + T5 findings from audit 1.
5. **Implementation**: P1, P2, P5, P6, P7 **DONE**. P3 (void-side capping in
   `invoices.service.ts`, build-plan §4) and P8 (ledger + code-map + lesson entry) **NOT done**.
   17 agents started / 15 results recorded in the journal (2 in-flight/lost when stopped).
6. **Not yet run**: review lenses, verify (perRound/final), sibling sweep, revert-fix probes.

## Dirty files committed in this checkpoint (16 modified + 2 new)

Modified:

- `.claude/pipeline/2026-09-01-f09-credit-notes-wallet/bug-test-plan.md`
- `apps/api/src/credit-notes/credit-notes.controller.ts`
- `apps/api/src/credit-notes/credit-notes.service.ts`
- `apps/api/src/credit-notes/credit-notes.wallet-integrity.pins.spec.ts`
- `apps/api/src/credit-notes/credit-notes.wallet-integrity.spec.ts`
- `apps/api/src/invoices/invoices.service.ts`
- `apps/mobile/__tests__/credit-notes-helpers.test.ts`
- `apps/mobile/app/(operator)/credit-notes/[id].tsx`
- `apps/mobile/app/(operator)/credit-notes/index.tsx`
- `apps/mobile/lib/api/credit-notes.ts`
- `apps/mobile/lib/credit-notes-logic.ts`
- `apps/web/app/(dashboard)/credit-notes/[id]/page.tsx`
- `apps/web/app/(dashboard)/credit-notes/page.tsx`
- `apps/web/lib/api/credit-notes.ts`
- `apps/web/lib/api/customers.ts`
- `apps/web/playwright.config.ts`

New:

- `apps/api/src/invoices/invoice-status-sets.ts`
- `apps/web/e2e/28-credit-note-wallet.spec.ts`

Plus this checkpoint adds `pipeline-args.json` and this `RESUME.md` under the run dir.

## Red-gate audit table (journal result entries #7 and #10 — journal.jsonl lines 15 and 21)

Both audits: `properlyRed: false`. Audit 1: `structurallyRed: false`. Audit 2 (after the one fix
round): `structurallyRed: true` — the fix round cleared every STRUCTURAL blocker but ONE
BEHAVIORAL blocker persists into audit 2 unresolved.

| #                          | Test                             | Audit 1 (pre-fix) outcome/note                                                                                                                                                                                                                                       | Audit 2 (post-fix) outcome/note                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1                         | assertion-failure                | Real: `invoicePayment.create` got 1 real call. Plan's 2nd oracle (`creditNote.update` not incremented) was **missing**.                                                                                                                                              | assertion-failure, same real failure; remediation added the missing 2nd oracle (per remediation notes for audit 1 → confirmed still red on its own distinct payload in audit 2).                                                                                                                                                                                                             |
| T2                         | assertion-failure                | Real, VOID fixture injected past query — proves apply-side guard only (documented, consistent with plan).                                                                                                                                                            | assertion-failure, own distinct payload (`cn-void-1`/`inv-void-2`) — same shape, still real.                                                                                                                                                                                                                                                                                                 |
| T5                         | assertion-failure                | **Wrong door tested**: called `settleOrderCreditsInTx(tx, orderId, tenantId)` instead of the plan's `autoApplyOldestCreditsInTx(tx, invoiceId, customerId)` (the real F07 send()/sendEmail() door at invoices.service.ts:3394/:3600). Effectively T1 with a 3rd arg. | **Fixed** — audit 2 shows a distinct payload (`amount 75`, `creditNoteId cn-send-1`, `reference CN-2026-0075`) hitting a different apply door than T1/T2; no longer a duplicate.                                                                                                                                                                                                             |
| T6 (VOID exception)        | assertion-failure                | `caught` is `undefined` — create() never throws today, so the `/VOID/` message oracle is **never reached**.                                                                                                                                                          | **STILL** assertion-failure on `undefined`/no-throw — identical failure text to T7. This is the **one blocker still open**: "a single generic guard rejecting every source status with one message would satisfy both T6 and T7" (BEHAVIORAL, journal line 21). Mutation probe must check T6/T7 independently (VOID-only guard must leave T7 red, WRITTEN_OFF-only guard must leave T6 red). |
| T7 (WRITTEN_OFF exception) | assertion-failure                | Same undefined/no-throw issue as T6, `/WRITTEN_OFF/` oracle unreached.                                                                                                                                                                                               | **STILL** identical failure to T6 — same open BEHAVIORAL blocker, not remediated.                                                                                                                                                                                                                                                                                                            |
| T9                         | assertion-failure                | Real (`creditNote.update` 0 calls). Plan's scoping oracle (`creditNote.findMany` called with `where: {invoiceId}`) was **missing**.                                                                                                                                  | assertion-failure, own distinct payload; scoping oracle assertion present per remediation.                                                                                                                                                                                                                                                                                                   |
| T10                        | assertion-failure                | Real, own distinct expected value ($40 = amountUsed); trailing negative assertions vacuous today.                                                                                                                                                                    | assertion-failure, positive half now non-vacuous per remediation (audit 2 line notes "positive half now makes the scoping oracle non-vacuous. Confirmed red.").                                                                                                                                                                                                                              |
| T12                        | assertion-failure (run manually) | **Misplaced**: plan says File=gate, but T12 sat in the _pins_ file, so the plan's gate command never executed it.                                                                                                                                                    | Not flagged as a blocker in audit 2 — relocation into the gate file was applied; now exercised by the real gate command (own real payload: missing `invoice` include).                                                                                                                                                                                                                       |
| T11                        | passed (VACUOUS)                 | Its only assertion is a negative that `voidInvoiceInTx` never calls today — passes against an empty function, proves nothing until R5 exists.                                                                                                                        | Not flagged as a blocker in audit 2 — remediation split it into a positive+negative pair per the prescribed fix; presumed resolved (verify directly before trusting — not re-quoted verbatim in audit 2's blockers).                                                                                                                                                                         |
| T3, T3b, T4, T8×2, T7b     | passed (legit pins)              | Pass because behaviour already exists — deliberate anti-regression pins, substantive, not proofs of the new requirement. Counted as a STRUCTURAL issue only because they sat in files not excluded from the red-gate's "0 passed" claim.                             | passed, same rationale — explicitly called out in audit 2 as "PLAN-DESIGNATED PIN... Not counted against structurallyRed." Resolved via the pins-file exclusion the remediation applied.                                                                                                                                                                                                     |

**Bottom line for the next session**: everything is real/behaviorally red except **T6 and T7**,
which still fail on an _absence_ (no exception thrown) rather than a _distinguishing value_ — the
single remaining BEHAVIORAL blocker per journal line 21. P3 (the void-side capping change in
`invoices.service.ts`, build-plan §4) has not been implemented at all, and it is very likely the
same P2/P3 boundary that will make create() actually throw for VOID/WRITTEN_OFF sources with
distinct messages — implementing it may resolve T6/T7 as a side effect, but **do not assume
that** — re-run the gate and the mutation probe (VOID-only / WRITTEN_OFF-only fixture) to confirm
each test is independently discriminating before calling the gate properly red.

## How a FRESH session continues

**`resumeFromRunId` is same-session only.** Relaunching the `bug-pipeline`/dev-pipeline engine
fresh on this tree is **WRONG**: Baseline would silently absorb everything already implemented
(P1/P2/P5/P6/P7) as "pre-existing", and the red gate can no longer be captured as red once the
fix is partially in place. The correct continuation is the **light loop**, run by hand from this
run dir, in order:

(a) **Implement P3** (void-side capping, build-plan §4) and **P8** (ledger + code-map + lesson,
see its row in build-plan.md and `pipeline-args.json`'s P8 entry) — Sonnet, targeted edits.
(b) **Run the red-gate spec** (`cd apps/api && npx jest src/credit-notes/credit-notes.wallet-integrity.spec.ts --runInBand`
plus the pins file) to confirm every REG test now passes and the designated pins still pass.
Specifically re-check T6/T7 independently discriminate (see mutation-probe note above).
(c) **Opus review lenses** over `git diff d12203a3...HEAD` — correctness, spec-compliance
(vs `spec.md` + `cause-ruling.md`), test-quality, edge-cases-and-security, operability,
scope-coverage — plus a **sibling sweep** for the two patterns in `pipeline-args.json`'s
`siblingPatterns` (`status: { not: "VOID" }` single-status exclusion; hand-typed
`"DRAFT" | "ISSUED"` enum unions — L-072).
(d) **Revert-fix probes by hand**: `git show d12203a3:apps/api/src/credit-notes/credit-notes.service.ts > apps/api/src/credit-notes/credit-notes.service.ts`
then re-run the gate (REG tests must go RED), restore with
`git checkout HEAD -- apps/api/src/credit-notes/credit-notes.service.ts`; repeat for
`invoices.service.ts`. Only the owner/lead restores if the classifier blocks the checkout.
(e) **Scoped gates** from `pipeline-args.json`'s `verifyCommands.perRound` then `.final`.
(f) **Close-out checklist**: `result.json` (hand-write a summary — the engine never returned
one), cost-ledger row (`node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append …`),
a ≤10-line entry in `~/.claude/skills/dev-pipeline/references/RUN-LOG.md`, a lesson entry
(or archive one fully-guarded entry if `.claude/lessons/LESSONS.md` is at the 40 cap),
and the code-map bump for every touched file (P8 covers this).

See also `closeout-drafts.md` in this run dir (written in this checkpoint) for what draft
close-out material already existed in the scratchpad — it was **empty**, so there is nothing to
reuse; close-out artifacts must be authored fresh by the continuing session.

**Do not merge. Not gated, not reviewed.**
