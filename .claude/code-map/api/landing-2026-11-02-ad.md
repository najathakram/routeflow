# Api landing 2026-11-02, train ad (merge commit `9e782a5dfc`, range `4b2516c9f2..9e782a5dfc`; train PR #4138, train head `c5bd1f3231`)

Paths under `apps/api/src/` unless they start with `apps/`, `packages/` or `scripts/`. Five members, each merged into the train by its own merge commit: #4123 `ee89a943d8` (web + mobile manifest row), #4135 `2d8ff74596` (web, static site), #4137 `325d19ddde` (web + one api DB spec), #4127 `f4e630e6b9` (api + web copy + pricing), #4136 `2267cc2a9d` (docs only: Train ac bookkeeping). **No migration** (no `apps/api/prisma/` path in the range), no cron, no plan flag or addon gate, no new env var. Web side: `web/landing-2026-11-02-ad.md`. Tests are named from the diff and the PR text and were not run for this note.

## #4127 `f4e630e6b9` order-wide refund bound, priced as charged, dead source (SA-1091, rows 631 and 333a)

Rule: what an order gives back (return refunds, store credit, lump and line credit notes) never passes what it was billed. The bound refuses, never clips: 409 `RETURN_REFUND_OVER_LINE_HEADROOM` for a return, 400 `CREDIT_NOTE_OVER_HEADROOM` for a note. Orders already over keep what they have; only later credits are refused.

- `credit-notes/line-credit-headroom.ts`, `credit-notes/credit-notes.service.ts`, `returns/returns.service.ts`: one gross bound over every value-giver (`loadOrderRefundRoom`, `orderRoomRefusal`, refuses at 0.1 of a cent).
- `returns/inline-returns-pricing.ts` (`priceMatchedChunk`), `returns/inline-returns-quote.service.ts`, `returns/inline-return-refund.ts`: an inline return takes net, tax and levy from `refundableLineShare` (`packages/pricing/src/refundable-line-share.ts`), so a priced return can no longer pass `Invoice.total` by a cent; a refusal from the helper is a 409, never priced at 0. The quote reads every invoice item once, sums what earlier inline rows took on every line (inline rows only), and a new take also stops at what is left of each charge across the invoice (`poolRoomOf`, beside `chargesOf`). AC-12: gross never above that chunk's default tax. Old rows are not repriced. The `inline-returns-pricing.ts` allowlist entry in `returns/refund-slice-single-source.spec.ts` is gone (closes the SA-840 inline follow-up).
- `returns/inline-returns.service.ts` `assertInlineSourcesOpen`: a held return or a replayed store-credit row whose source invoice was voided or written off is refused 409 `RETURN_NOTHING_BILLED`, before any write.
- `processRefund` passes `returnId` on every refund mint (the second link write is gone). Every order-bound refusal carries `orderBound: true` and a numeric `remaining`.
- `scripts/report-sa1091-order-bound-census.mjs` + `returns/order-bound-census.ts`: read-only census (counts and buckets only; exit 64 on a remote host without the flag, 65 on a wrong host, 2 on a write flag; session and transaction read-only, ends in `ROLLBACK`). Not run against production: that waits for the owner's per-call yes.
- Tests: `credit-notes/order-refund-bound.pin.spec.ts`, `order-refund-room.spec.ts`, `unlinked-refund-lump.pin.spec.ts`, `returns/inline-returns-pricing.as-charged.sa1091.spec.ts`, `inline-priced-as-charged-sa1091.db.spec.ts`, `inline-return-dead-source-sa1091.db.spec.ts`, `order-refund-bound-sa1091.db.spec.ts`, `order-bound-census.db.spec.ts`, `common/report-sa1091-order-bound-census-script.spec.ts`, `common/scripts-live-target-guard.spec.ts`, `packages/pricing/src/refundable-line-share.spec.ts`. Review notes left open: three census mutants survive (gross forgets the levy, an order-less invoice, not-goods stored), the census transaction has a 120 s limit.

## #4137 `325d19ddde` cleared tier bills Retail (SA-1092)

- Api side is one DB spec only: `orders/cleared-tier-bills-retail.db.spec.ts` (QT-6): a Tier 2 customer with the tier cleared, buyer cart and staff order each bill 24 with the real Tier 2 product at 20. No api source change.

## #4123, #4135, #4136

- #4123, #4135: no api source; see `web/landing-2026-11-02-ad.md`. #4136 `2267cc2a9d`: docs only (landing notes for train ac, B238 closure).
