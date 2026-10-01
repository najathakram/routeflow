# Domain principles the SA seat has paid for (money / units / ledgers / stock)

Each line is a generalizable rule, not an incident; the id is where the full ruling lives in the project's `RULINGS.md`.

## Quantities and packs

- **The pack rule (SA-063, proposed R-029).** A stored line's pack is its OWN snapshot — `packSize`, `unitsPerBox`, or the pack its own boxes/pieces split implies (`(qty − pieces) / boxes`, integer > 1). Every path that needs a STORED line's pack reads the line. The live product's pack is read in exactly two situations: a NEW line at its write moment (and snapshotted onto it in that write), or a stored line with neither snapshot nor split, as a fallback that warns with the line id and both packs. A product pack edit never rewrites an existing line. A pack of 1 or null is no packaging, never a sentinel.
- **A delete-and-recreate rebuild carries every snapshot forward from the rows it replaces (SA-078e).** Read the soon-to-be-replaced rows' own snapshots by their stable key (the order line id survives rotation) BEFORE deleting them and prefer them over any parent-record or live fallback; a rebuild that re-derives from a parent that deliberately stores null re-snapshots at today's live value on every reconcile.
- **A payload can be self-describing (SA-068).** When a DTO carries no line id and the client sends boxes/pieces/qty consistent with the line's own snapshot, derive the pack from the payload's own split; positional correlation is refused (a wrong correlation applies another line's pack). Undecidable → store as sent, snapshot null, warn — never normalize at the live pack, never overwrite qty from boxes × livePack + pieces.
- **Base unit, not selling unit, in every ledger and stock figure.** `currentStock`, `unitBasisQty`, restocks and returns count pieces; a box-unaware line that decrements boxes is the defect, not a convention (SA-060).
- **Unit factors are immutable once a document references the level (R-002).** Documents snapshot quantity-in-base; the server resolves factors from the ladder, never from client input.

## Ledgers and reversals

- **Axis rule (SA-048).** Every REVERSAL writer books the piece axis derived from the SALE rows it reverses: exact remaining on close; partial = the line's own qty ratio, never money (a discounted partial credit's $ share ≠ its goods share); a money-only credit books 0 on both quantity axes; seed from every prior reversal kind. Grep every writer of the axis before ruling; there were four, and the third was the one nobody read.
- **Caller-declared axis.** When callers arrive in different units (line units vs pieces), the reversal takes the caller's axis natively and derives the other by the same fraction, clamped to its own remaining (SA-053).
- **Era detection by content, never timestamp (SA-051/058/070a).** `|unitBasisQty| = |qty|` on a box-unaware boxed line is the box axis; `>` is the piece axis; `<` or non-positive is malformed → unknown. The column that did not change across eras (`row.qty`) is the safe read for a cases bucket.
- **Correction rows (SA-069).** Typed like the row they correct; signed deltas; `correctsEntryId`, `originalSoldAt`, `soldAt = now`, `periodBucket` = the corrected row's (UNFILED periods only); every line-key id copied verbatim so idempotency guards fold them in. Readers iterate original rows only; corrections are folded into remaining maps, never treated as a second sale row — and that reader change must DEPLOY before the first correction is written (SA-070). One formula per row: `target = row.qty × packAtSale`; money only for over-closed reversals via a completeness-asserted replay.
- **Parking beats a guess (SA-033/067).** An unknown basis parks the ledger reversal (return, restock and customer credit proceed); the filing gate refuses while a parked row exists; cancelling the return deletes its unresolved parked rows or the period is blocked forever.
- **Filing gate on the data (SA-061).** A sum across mixed-era rows is a DATA defect: no filing for a period holding a non-clean line until the correction runs; reader tricks apply only where a column is era-invariant. Filed (generated) periods are never touched — tax advisor.
- **Resync and re-read (SA-047/062).** A resync of an old line must re-derive from the line's own snapshot; the live pack is only for snapshot-less legacy lines, which the correction routine owns.

## Returns, credits, refunds

- **A return credits what the customer PAID (SA-064):** subtotal share + regular-tax share + category-tax share, prorated on the goods axis, per component, never recomputed from a live rate; ONE pricer for standard and inline paths; the credit-note cap is the line's billed total, and CN lines carry components so the credit's levy equals the ledger's reversal.
- **Over-return (SA-071):** allocate newest-invoice-first across the customer's invoice lines at each source line's stored rate; the excess is one chunk at the customer's current price with a reasoned manual override, or removed — goods are never refused; one credit note, no invented cash path.
- **Quantities are the client's authority (SA-071b §5 as amended).** The server recomputes money for whatever quantities arrive; the submitted quantities must derive from the same state the displayed quote was computed against, and every re-quote writes back into the submit-state — a screen that can re-quote without syncing is a money bug every price guard passes.
- **Idempotency keys travel with the client** (`returnKey` minted once per attempt and held stable across retries as state); a replay is indistinguishable from a fresh capture on the wire BY DESIGN — any 200 is success, rendered from the returned row; there is no `replayed` field on the response (SA-071a as amended).

## Stock and purchase orders

- **Cost denomination on a PO line (SA-041):** `packSize` non-null = entered per case; `totalCost` is the money authority computed server-side from entered figures; per-piece cost is derived for costing only and never multiplied back into a total; a document's money is READ on display, never re-derived.
- **Restock in pieces via the shared pack resolver; unknown packs park; the sale-side decrement is fixed on the sale side, never mirrored on the restock (SA-060).**

## Concurrency

- **Read the locked rows, not the pre-tx snapshot (SA-068d).** After `FOR UPDATE`, every diff-branch read resolves from the held map; `held ?? snapshot` is an acceptable interim when a missing row then fails loudly (P2025 rollback) rather than writing a wrong figure; the clean 409 needs a client snapshot token (`items[].expectedQty`).
- **Advisory locks per customer for merges; per-job leader locks for crons; never a second in-process lock.**

## Refusals the SA makes on sight

- Reconstructing a pack from money (`unitPrice × pieces / subtotal`) — a discount turns it into a plausible wrong integer.
- Prorating a quantity off a money share.
- A NON_WRITERS-style unbounded exemption where a count pin will do.
- Cancelling a document line from a reversible draft edit.
- Replaying an event log to recompute state without a completeness assertion.
- Any ruling stated from a working tree instead of a fetched origin sha.

## Scripts and executed artifacts (SA-076a; L-176 was the symptom)

- **A prod script runs the build, not the source.** "The numbers match the spec" is a claim about `src`; what executes is `dist`. The package build stamps `dist/build-info.json` with a content hash of its source (sorted files + bytes, never git state); a shared `assert-*-dist-fresh` helper recomputes it over the checkout and REFUSES on mismatch or a missing stamp; every prod script calls it before its first read, and a planned run records the stamp so apply refuses if the code differs from the code that planned. Rebuilding as preflight is routine, not the control. Importing source under a loader in a prod money script is refused.
- **Evidence outside the table you write is part of the plan.** Hash every input the pure functions consumed (row, line shape, source-candidate set and count, gate inputs with null vs omitted distinguished, return/credit evidence); re-run the same queries under the row locks at apply and refuse on any mismatch. A fingerprint over a whole table's newest row makes apply impossible on a live system; scope concurrency to the plan's rows.
