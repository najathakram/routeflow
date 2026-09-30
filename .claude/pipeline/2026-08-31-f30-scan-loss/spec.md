# F30 · Mobile scan-to-order loss — spec

**Status: EXECUTED (Fable)** · scale **MAJOR** (money + silent data loss, active customer pain)
· ONE PR (the Idempotency-Key contract spans client+server; mobile binary ships via Expo
independently of PR structure) · base `master` post-F02b · board #549 · IDs B190–B201 + the
reachable cuts of B143/B111/B151. **Discovery = the F30 card** (verified mechanism chains from
workflow wf_fc0b83ce-ced; 3/3 CONFIRMED under adversarial refutation) — do not re-derive it.

## The W's (owner directive)

WHO: operators and customers scanning multi-item orders on mobile — the primary order-taking
surface. COST: silent line loss, wrong quantities (money: box-repriced merges overcharge by
unitsPerBox), duplicated whole orders, false "not found" — invisible to users AND logs. WHY NOW:
owner-reported, reproducing in production this week. DONE MEANS: a 30-scan burst on a flaky
network produces exactly the scanned lines, every failure is visible, and the register's twelve
mechanisms each have a red-proven regression.

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Bugs           | Prio |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ---- |
| R1  | Scan gate dedupes on the NORMALIZED candidate set with a small multi-slot LRU (≥4 codes); cooldown refreshes ONLY on accepted scans (a rejected duplicate never extends suppression)                                                                                                                                                                                                                                                                                                 | B190 B191      | P0   |
| R2  | ScanCamera never silently drops: bounded pending buffer (depth 2) + an `isResolving` indicator surfaced in ScanOrderSheet; resolve timeout for scan lookups cut to 5s. **Amended during build:** normalized dedupe belongs to R1's gate and ONLY there — every code reaching the buffer was already accepted, so a second dedupe here could only overrule that verdict, which is B192 itself ("scanned twice during one slow lookup ⇒ qty 1"). The buffer is a FIFO queue, not a set | B192           | P0   |
| R3  | Wedge path: search field cleared SYNCHRONOUSLY at submit (the web CreateOrderModal invariant); a burst arriving mid-resolve buffers, never concatenates                                                                                                                                                                                                                                                                                                                              | B193 B201      | P0   |
| R4  | `sale-line` boxed increments FOLD an existing plain qty (typed 10 + scan ⇒ 10 units + 1 box worth, per the normalize/rollover convention) — never discard it                                                                                                                                                                                                                                                                                                                         | B194           | P0   |
| R5  | Resolve rungs agree about archived products: fallback search drops `isActive:true`; an inactive best-match returns a distinct `archived` outcome ("X is archived — reactivate to sell") and is NOT silently added; draft-resume keeps archived lines with a visible flag instead of deleting them                                                                                                                                                                                    | B195           | P0   |
| R6  | The offline queue NEVER silently discards: 4xx and retry-exhausted actions move to a persisted `failedActions` list surfaced via alert + badge (B143/B111 cut); iOS `showToast` routes to the existing InlineToast host (B151 cut)                                                                                                                                                                                                                                                   | B143 B111 B151 | P0   |
| R7  | A timeout while NetInfo reports online is NOT "offline": no enqueue, the error surfaces in-flow; queue replays reuse the original queued config (`_offlineQueued` preserved) so a timed-out replay increments its own entry instead of enqueuing a duplicate                                                                                                                                                                                                                         | B196           | P0   |
| R8  | POST /orders carries a client-generated `Idempotency-Key` (uuid per cart session); server honors it (tenant+key unique, replay returns the original order) — the duplicate-order leg dies even under queue bugs                                                                                                                                                                                                                                                                      | B196           | P0   |
| R9  | `updateOrderItems` diff-add: an unresolvable productId aborts with a 400 naming the ids — never `continue` into a 200 with missing lines                                                                                                                                                                                                                                                                                                                                             | B197           | P0   |
| R10 | `replaceAll` is explicit-only: default false, never inferred from an id-less payload shape                                                                                                                                                                                                                                                                                                                                                                                           | B198           | P0   |
| R11 | The staff create-merge is denomination-aware and lossless (boxes+boxes, pieces+pieces with rollover via `normalizeBoxesPieces`; unitPrice/notes preserved) and runs inside a transaction with an atomic claim so concurrent merges cannot clobber lines                                                                                                                                                                                                                              | B199           | P0   |
| R12 | Customer-role scanning works: a CUSTOMER-permitted, catalog-visibility-scoped barcode lookup (reuse `findByBarcode`'s normalize path filtered to the buyer's visible catalog)                                                                                                                                                                                                                                                                                                        | B200           | P1   |

## Deploy-day answer

Server half deploys on merge: R9/R10/R11 harden endpoints every client already calls — stricter
(400 where 200-with-loss was) but only on payloads that were losing data anyway; R8's idempotency
table is a new additive migration-less unique (needs a table → NO: use a `IdempotencyKey` column?
— decision: a small additive migration IS required for the tenant+key unique store; slot
`20260910000000_order_idempotency`, additive-only, applied per D3-style flight before merge).
Mobile half reaches users on the next Expo build — until then old clients keep old behavior
against a stricter, safer server (no breakage: R9/R10 only reject payloads that were corrupting).

## Non-goals

- No offline-queue redesign beyond R6/R7 (F19 owns session teardown/identity stamping).
- No global mobile error-boundary work (F20 owns the toast-host generalization; R6 wires iOS
  minimally through the EXISTING InlineToast).
- No barcode symbology changes; no camera library swap.
- B47's edit-path denomination bug stays with F06 (this batch fixes the CREATE-merge, B199).
