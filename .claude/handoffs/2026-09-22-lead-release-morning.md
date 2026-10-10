# Fleet lead handoff — release morning (2026-09-22, written 08:05Z)

For a lead session picking this up cold. Board of record is GitHub issue **#938** — read the last
~10 comments; they are more current than this card. Owner-facing detail:
`local-assets/handoff/2026-09-22/GO-NO-GO-BRIEF.md`.

## The one thing to understand

B661 (#1207) merged at 06:39Z and **auto-deployed to production within a minute**. It was meant to
be the release gate. It desynchronised **three** readers of the regulated ledger's `unitBasisQty`:

1. **Returns** — a fully returned sale reverses ~8% of itself (5 boxes @ pack 12, $50 → books
   −$4.17). Live in production. Lane F is fixing it — "axis follows the caller": LINE_UNIT callers
   compare against `remQtyByLine`, PIECES callers keep `remUnitBasisByLine`. Both maps already
   exist on master.
2. **Credit notes** — phantom pieces per credited line, never self-healing because
   `reverseInvoiceEntries`' skip-guard omits `unitBasisQty`. MacBook is fixing it.
3. **`tx-report.ts:328-333`** — possible 12× over-report, gated on `regUomCase`. Needs a prod count.

**Revert was considered and rejected.** Pre-B661 the _inline_ return path over-reversed whole sales;
reverting trades under-reversal for over-reversal. Confirmed by three independent analyses.
**Do not revert without re-reading that reasoning on #938.**

## Standing rules I added today

- **No merge without an independent PASS posted to #938 at the exact sha.** Tier 1 (pricing,
  regulated, invoice/order money paths, migrations) = mandatory, no exceptions, including if the
  lead asks. Tier 2 = CI green + a verdict pinned to a sha. This exists because I merged #1207 on a
  verdict I read in a 3-hour-old handoff file, and it put a live money defect in production.
- **A verdict describes a SHA, not a PR.** Verify against the merged sha (`git blame`) before
  acting on any HOLD or note.
- **Two reviewers on money paths** where a second is free. A second read caught a permanent
  deadlock in #1185 that a thorough first review had passed.
- One verify slot on the PC (RAM-bound, ~40 min/cycle). Disk is fine — 70 GB, not the 3.3 GB the
  old handoffs claim.

## Window plan

10:00Z: #1147, #1208, #1215, #1089, #1216 (all PASSed). ~12:00Z: ledger fixes, #1045, #1210 —
**everything UI-visible must be merged before the 13:00Z proof**, or the proof doesn't cover what
ships. 13:00Z proof → 13:15Z owner migration → 13:30Z train (**#1184 → #1217 → #1218 only**,
backend) → 14:00Z go/no-go.

## Held

**#1185** — HOLD, deadlock: the sync loop zeroes `invoicedQty`, which `fullyCovered` also uses to
mean "was ever billed", so a released line becomes permanently unbillable and uncancellable.
**#1121** — HOLD, re-derives the split from the live product. **#1187/#1190** — dropped (B660), left
open deliberately with the reasoning recorded. **B663** — cut to fast-follow.

## Owner decisions pending (back ~12:30Z)

**B681** — historical rows in an unknowable convention; also degrades the credit-note fix on lines
straddling today's deploy. Recommend the narrower option unless the count is small. Plus the
tx-report count. Both queries are in the brief; both need `railway run` and per-call approval.

## Mac mini

Silent since 06:43Z. Lane B's reviewed credit-note fix (`80b17cf5`) is stranded there, never
pushed. **F2 owns the 13:00Z RC proof and has not confirmed** — fallback plan is
`local-assets/handoff/2026-09-22/PC-RC-PROOF-PLAN.md`, U-units drives, decision at 10:00Z.

## Filed today

B682 (strict ambiguity guard has zero callers — the structural fix for this whole family),
B683 (stale comments contradicting their own code — cost ~3 hours today), B684 (PriceEditor
missing the B606 guard). All fast-follow. PR #1216.
