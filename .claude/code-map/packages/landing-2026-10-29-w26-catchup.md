# Packages, mobile and control landing 2026-10-29, w26 catch-up (master `b1a2fc3d1` exclusive .. `75f433f56`; trains W21-W25)

Paths from the repo root. Tests not indexed. Web part: `web/landing-2026-10-29-w26-catchup.md`. Api parts: the api landing files. Newest first inside each package. No size-ratchet baseline change for any file here.

## packages/pricing (`@routeflow/pricing`)
- #3965 / #3800 `c7b0c685b` standard-return refund includes invoice tax (B704, SA-970, SA-980): new `src/refundable-line-share.ts` - `taxRateMicros`, `refundableLineShare(input)`, `refundableProductPoolShare(input)` (slices a product-only return item over the invoice's product pool), `refundableInvoiceOf(...)`, types `RefundableInvoice`, `RefundBreakdown`, `ProductPoolShare`, `StoredInvoice`. Exported from `src/index.ts`. Api consumes it; there is no web mirror.
- #3902 `2b2112b14` invoice display units (SA-827 T1): new `src/invoice-display-lines.ts` - `invoiceDisplayUnitFor`, `displayUnitSnapshotOf`, `displayUnitForItem`, `invoiceDisplayLines(item, components, displayUnit)` (largest-remainder split of the stored net subtotal, rows sum to the box line), `invoiceDisplayCategoryTax`, type `CustomerInvoiceUnitDefault`. Display-only: a pin forbids these names in money writers.
- #3752 `a84c5d8ab` price history comparison: new `src/unit-price-convert.ts` - `pricePerBaseUnit(unitPrice, piecesPerUnit)`, `priceInUnit(perBase, piecesPerUnit)`; unrounded until the end.
- #3853 `3e1eb4dfa` hold approval below the held credit: new `src/scale-frozen-split.ts` - `scaleFrozenSplit(split, approvedGross)`, type `FrozenSplit` (`{ net, tax, categoryTax }` scaled pro rata; tax parts rounded, net takes the remainder).
- #3848 `95a57846a` line ambiguity warn phase (139, SA-982 PR-2): `src/pricing.ts` adds `AMBIGUOUS_LINE_REASONS` (BOXED_NO_SPLIT, NON_INTEGER, QTY_DISAGREES, ZERO, SPLIT_NO_PACK, BAD_QTY), `AmbiguousLineReason`, `lineAmbiguityDetail`; `AmbiguousLineError(message, reason)` carries `reason`; `lineAmbiguity` keeps its string return; `src/build-line.ts` sets a reason at each throw.
- #3807 `8bc734be2` (row 513) `src/unit-options.ts`: `ladderOptionDetail`, `ladderOptionText`, `derivedPackSplit`, `packPiecesSplit`; `no-inline-pack-split.pin.spec.ts` keeps hand-rolled pack splits out.
- #3797 `b291c7195` (621) `src/unit-levels.ts`: `baseRow` is the factor-1 row whatever it is named; the label only picks the level a line asks for.
- #3743 `859468f97` `src/counter-tender-split.ts`: tender text takes `opts.checkReference`, so the CHECK leg reads "Check #1042" in the reprint and the emailed receipt.
- #3877 `d0c41b65a`, #3882 `dbbaca17a` `src/counter-day-close.ts`: the not-at-till line is labelled "Paid outside the till".

## packages/types (`@routeflow/types`)
- #3971 / #3810 `cf95821ea` `api/error-codes.ts`: `ROUTE_HAS_DELIVERY_EVIDENCE` (delete of a route or run that holds delivery records, 409).
- #3941 `22ff8274e` (SA-1042 B9b) `api/returns.ts`: a return item may carry `orderItemId`, `boxes`, `pieces`; error codes `RETURN_LINE_NOT_ON_ORDER`, `RETURN_LINE_COUNT_SHAPE`, `RETURN_LINE_MIXED_WITH_POOLED`.
- #3940 `eadc1542c` `api/enums.ts`: `TENANT_STATUS_VALUES`, `TENANT_PLAN_VALUES`, `USER_STATUS_VALUES`, `BUYER_ACCOUNT_STATUS_VALUES`, `CUSTOMER_LINK_STATUS_VALUES` with derived types; parity rows in the api enum-parity spec.
- #3900 `d960391b0`: `api/counter-sale.ts` request takes `inlineReturn` (`InlineReturnLinesRequest`); error `RETURN_CREDIT_CHANGED`.
- #3890 `d65a1574f` (SA-1026 A): `api/enums.ts` `TO_COLLECT_METHOD_VALUES` (CHECK), `TO_COLLECT_STATE_VALUES` (TO_COLLECT, NONE, UNKNOWN); `api/counter-sale.ts` `expectedMethod`, `toCollect`; `api/orders.ts` `OrderToCollectField`; error `COUNTER_EXPECTED_METHOD_NEEDS_ON_ACCOUNT`. #3743 adds `checkReference` and #3891 `52b61ca9d` adds `invoiceIds` (every invoice the sale or hand-over made, in issue order) to the counter sale and pickup-complete responses.
- #3902 `2b2112b14`: `api/invoices.ts` `InvoiceDisplayUnitView { kind: "legacy" | "pieces"; label }`; `api/buyer.ts` invoice line gains `components`, `displayUnit`, and `trackedCategory` narrows to `{ name }`.
- #3870 `b65e46233`: error `WALK_IN_STORE_CREDIT_REFUSED`. #3707 `41a998c6e`: error `COUNTER_COMPLETE_DAY_CLOSED`, copy in `counter-copy.ts`; `PickupCompleteRequest extends RestrictionAck`.
- #3842 `171e20170` (B330): new `licence-validity.ts` - `licenceExpiryCutoff`, `isLicenceExpired`, `isLicenceLive`, `displayLicenceStatus`; re-exported from `index.ts`; mobile imports `@routeflow/types/licence-validity` (its jest config maps the subpath). Intl only.
- #3834 `c93658333` (row 562 S1): new `api/stock-count.ts` - `StockCountSeedState`, `stockCountSeedState(row)`, `StockCountProgressResponse`; `stock-count-commit-copy.ts` adds `STOCK_COUNT_SEEDING_COPY`, `stockCountPreparingCopy`, `stockCountPreparingLine`; errors `STOCK_COUNT_SEEDING`, `STOCK_REFERENCE_RESERVED`, `STOCK_COUNT_ID_TAKEN`.
- #3726 `9eab5fec4` (B297 PR5): errors `FILED_PERIOD_LOCKED`, `LEDGER_PERIOD_LOCKED`, `FILING_NOT_LOCKABLE`, `FILING_ALREADY_LOCKED`, `FILING_PERIOD_RUNNING`, `FILING_STALE`, `FILING_LOCK_NOT_READY`; `FILING_STALE_COPY`, `FILING_LOCK_READY = false`, `FILING_LOCK_NOT_READY_COPY` (each pinned byte-equal to an api literal).
- #3766 `f5a023da1` (SA-950 A) `api/features.ts`: `FEATURE_PURPOSE_VALUES`, business and commercial category values, `FeatureNature` union, `FeatureRelease`, `FeatureIncomplete`; registry rows carry `purpose`, `category`, `keywords`, `incomplete`, `release`.
- #3752 `a84c5d8ab`, #3883 `d2ae41db7` `api/price-history.ts`: `PriceHistoryAveragePoint`, `PriceHistoryComparisonLine`, `comparison?`, row `salePack` (1 piece, > 1 pack, null unknown).
- #3893 `f4380d60c`: `fixtures/business-capabilities.unset.json` (the unset tenant's server answer, asserted by an api spec); #3857 `4d93e09ad` `api/products.ts` open-order status comment only.

## packages/ui (`@routeflow/ui/web`)
- #3745 `accbfbf33` `src/web/Modal.tsx`: overlay and content ease out over 200 ms on open, ease in over 150 ms on close (reduced motion still off).
- #3891 `52b61ca9d` `src/web/Toast.tsx`, `index.ts`: `useOptionalToast()` returns the toast API or null without a provider.

## apps/mobile
- #3842 `171e20170`: `lib/customer-authorizations-logic.ts` `displayAuthStatus(a, now, zone)` delegates to `displayLicenceStatus`; `app/(operator)/customers/[id]/licenses.tsx` passes the business timezone; `jest.config.js` maps the licence-validity subpath.
- #3726 `9eab5fec4`: new `lib/filing-status.ts` (`filingStatusLabel`, `isFiledOk`; LOCKED reads "Locked", not "Failed"); `components/RegulatedFilingsList.tsx` uses it.
- #3846 `69dcf543c`: `hooks/useBuyerSocket.ts` refreshes statement, remittance, invoice and payment views on `creditNote.created` and `creditNote.voided`.
- #3807 `8bc734be2`: `lib/unit-options.ts` re-exports `derivedPackSplit` and wraps `ladderOptionText` / `ladderOptionDetail` from pricing with its own formatters.

## apps/control (`@routeflow/control`, isolated service and `ctl` CLI, no runtime deps)
- #3874 `2271fa2bb` (B1-a2): `src/sources/registers.ts` `loadRegisters` takes `registry?: { repoDir, sha, prefix? }`; reads `bugs.jsonl` and `status/` from that location (default stays the tracked `.claude/campaign` prefix until B1-c), cache key carries both shas; new `readRegistrySource()` reads `scripts/lib/registry-source.json` (repo, branch, prefix). `src/http/server.ts` and `src/cli/ctl.ts` pass `registry`. `Dockerfile` copies the json; `railway.toml` `watchPatterns` adds it.
- #3747 only touched `test/wp7-security.spec.ts`.
