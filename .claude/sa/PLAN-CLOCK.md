# Plan clock + measured baseline — SA

> **WORKING CLOCK (R-026, owner DIRECT, 23:40Z 2026-09-20): 10:00 am EASTERN 2026-09-21 = 14:00Z. Nothing cut; mobile website in scope.** (The lead's relayed 10:00 GMT is superseded.) Every brief states hours-to-10:00-GMT. The Day 0 to Day 7 table below is kept as the record of SCOPE and estimates only; it is void as a schedule.

> Re-derive each brief; never relay. Clock source: EVALUATION-remaining-work.html §5 + git.
> Day 0 = night 09-18→19 CDT (#933 00:03, #934 00:45, #936 01:52 CDT 09-19). Day N = 2026-09-(18+N). Day 1 = Sat 09-19. Day 7 = Fri 09-25. (SA-001; the FINAL prompt says Day 0 = Sat 09-19 — see RULINGS.)

| Days | U units + POs                                                            | S scanner + order UI                       | R labels + restrictions                                               | B backoffice + tooling                           |
| ---- | ------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------ |
| 1–2  | ladder + specs → unit API + editor                                       | W2, W3 · B564/B565 · buyer table           | service (3 outcomes) · choke point + meta-spec · normalization script | A1 · T2 · T3 · Vigil audit                       |
| 3–4  | unit-aware write paths (CRITICAL, Opus)                                  | W4 · W5                                    | labels API/UI + opt-out · OWNER runs normalization on prod            | A3 fixes · A2 (OWNER applies snapshot migration) |
| 5–6  | unit picker · PO edit/re-apply · PO from scan                            | T6 card list + T7 · typeahead + line merge | restrictions admin + buyer hiding · tenant settings                   | T6 NOT NULL · PR-0 deletion · B462               |
| 7    | mobile mirrors, integration proofs (F), two landing windows, bookkeeping |                                            |                                                                       |                                                  |

## Baseline @ origin/master 5c0239e6 (2026-09-20 16:36 CDT), measured 17:30 CDT = end of Day 2

- Merges since plan base 357db4a6: 147 (UTC days: 09-19 40 · 09-20 107).
- By card (titles, hand-corrected; sums to 147): R1 45 · credit 15 (only D6 #968/#999 is planned; B585/B577/B584 are not in the plan) · A2 + B593 15 · B-tooling 10 · U2 7 · S2 7 · U1 6 · routes fixes 6 · orders/invoices refactors 6 · S1 4 · PR-0b 2 · A1 1 · A3 1 · other tooling/docs/obs/email/deps 22. U+S together 24.
- Units: resolveLineUnits production callers 0 · writer table CONVERTED 0 · GUARDED 7 · PACK_ONLY_CREATE 5 → 12 to convert. [apps/api/src/orders/unit-line-writers.ast.spec.ts]
- Restrictions: ENFORCEMENT_POINTS 16 · GUARDED 3 (create, updateOrderItems, changeStatus) · PENDING_BASELINE 13. [apps/api/src/selling-restrictions/sellable-writers-coverage.spec.ts]
- Ratchet margin (baseline + 25 − lines): orders.service.spec.ts 0 · customers.service.ts 0 · invoices.service.spec.ts 6 · products/[id]/page.tsx 10 · NewOrderScreen.tsx 13 · edit-items.tsx 14 · customers/[id]/page.tsx 18 · routes.service.ts 23 · customers.service.spec.ts 23 · ScanInvoiceModal.tsx 25 · orders.service.ts 51 (5854 of 5905) · invoices.service.ts 70 · orders/[id]/page.tsx 140 · inventory/page.tsx 975. marketing.css not measured.
- Baselines never lowered after a shrink (R-022): inventory/page.tsx 3303 vs 2353 · orders/[id]/page.tsx 3728 vs 3613 · invoices.service.ts 6412 vs 6367 · orders.service.ts 5880 vs 5854.
- Unlanded lane branches (tip CDT · behind master · own commits): s-scan-price-editor-v2 12:26·17·2 · s-scan-poor-signal-v2 14:36·17·5 · s-order-10-add-line-merge 14:36·10·7 · s-order-11-rn-line-cards 16:22·17·6 · u-orders-create-unit-wire2 12:44·20·15 · u-invoice-create-unit 14:35·10·28 · u-product-units-web 16:22·134·15 · u-unit-picker-5a 14:13·134·15 · u-po-edit-lines-table 16:22·80·2 · u-po-scan-toggle 16:22·17·4. Last S merge #985 at 09-19 23:16 CDT. Remote heads 223.
- Migrations after the #936 spine: 20260919120000_tenant_feature_config_snapshot (#1002) · 20260920010000_product_category_label_parent_pin (#990). Prod apply + drift exit 0: NOT evidenced to the SA (R-021).
- Bookkeeping: code-map mappedSha a3c37bdb, last refresh #939 (09-19 02:10 CDT) · lessons last touched by #975, 38 fix merges since, register 51/52.
- Hygiene: f62c318b (#1010, credit-limit-guard extraction) sits on master with an EMPTY commit subject.
- This Mac main checkout: b5192589, 65 behind origin/master, 9 modified .claude/campaign/bugs files. The SA reads origin/master only.

## Hour 0 (2026-09-20, master still 5c0239e6) — measured by the SA unless marked

- Prod drift: lead's command output at 23:06Z — `prisma migrate status` up to date with 44 migrations, `migrate diff` exit 0. SA verified 44 migration folders at 5c0239e6. #1002 and #990 are applied (R-021 met).
- API spine trial merge in the lead's order, object database only: #1123 clean (+6) → #1090 clean (+28) → #1101 clean (+0 on orders.service.ts; its +28 is #1090's). Result: orders.service.ts 5888 of 5905 → 17 left · invoices.service.ts 6389, and #1101 lowers that baseline to 6390 → 26 left. The lead's relayed 5882 is #1090 alone on today's master.
- #951 (unit editor): CONFLICTS with master in products/[id]/page.tsx, and is 7 over the ratchet after merge (2957 + 17 = 2974 vs 2967). Branch predates the ratchet spec. feat/u-unit-picker-5a is stacked on it (14 of its 15 commits).
- #982: 5 files (CreateOrderModal.tsx + add-line-merge). master + #982 merges clean. Shares no file with #951. `LineItemState` lives in the invoice pages; `renderLineItem` exists nowhere on master. Merge key: `li.productId === product.id`, mapped over every matching line; header says unit keying is deliberately not handled.
- B608: "PO edited" appears nowhere in apps/ or packages/. Only notes parse left: inventory.service.ts:1505 (reversal prefix). record-adjustment.dto.ts lets an operator set both reference and notes, so it is forgeable; a forgery only shrinks the live set, so the qtyReceived equality check refuses (fail closed).
- Restrictions switch: PATCH settings/restrictions = JwtAuthGuard + RolesGuard + @Roles(TENANT_ADMIN), no entitlement gate (restrictions-settings.controller.ts:13-32). Page /settings/restrictions has no feature gate in its own directory; nav link not found in the files checked (unverified).
- Buyer 409: selling-restrictions.service.ts:423 sends `blockedLines: evaluation.reasons` with no channel shaping anywhere in apps/api/src; each reason carries ruleId, categoryName and a message embedding the admin's free-text reason (selling-restrictions.core.ts ~328-345).

## Hour 0b (2026-09-20 ~18:00 CDT, master 7209edae) — measured by the SA

- Merged since 5c0239e6: #1123 (B606, 2287577d) and #1126 (B612, 7209edae). orders.service.ts 5860 of 5905 (margin 45); orders.service.spec.ts margin 0; invoices.service.spec.ts margin 6; products/[id]/page.tsx margin 10.
- #1126 verified: apps/api/src/selling-restrictions/selling-restrictions.service.ts builds a BuyerBlockedLine list of productId + productName for every non-staff or unknown channel; staff keep evaluation.reasons.
- Trial merge on 7209edae: #1090 clean → orders.service.ts 5888; then #1101 clean → 5888, invoices.service.ts 6389; neither touches the two service specs. #951 still conflicts in products/[id]/page.tsx.
- #1090's head on origin is still eb57d68b (12:44 CDT): the "merged with master, pushing now" push was not on origin at this fetch.
- credit_limit.* is owner-held: PATCH /settings (apps/api/src/system-config/settings.controller.ts:120) allowlists taxRate and logoUrl only; no endpoint or script writes the two keys. Documented bypasses and the no-lock limit: apps/api/src/orders/credit-limit-guard.ts:240-268.
- In flight on origin: feat/r-mobile-credit-modal (B585 mobile mirror, frozen by SA-008); feat/b585-deliver-gate looks like a leftover of merged #1080 (tip 06:50 CDT, 57 behind).

## Deadline night (2026-09-20 ~23:30Z, master 7209edae) — measured by the SA

- PR sizes vs merge-base: #1090 6 files +376 (api) · #1101 14 files +825 (api; about +450 own) · #982 5 files +648 (web) · #989 9 files +908 (mobile, web, turbo.json) · #1048 2 files +334 (web, 82 behind) · #1045 5 files +112 (web) · #984 3 files +241 (api) · #1121 2 files +35 (web).
- Chained merge-tree in the lead's order (1027, 1090, 1101, 982, 1121, 989, 1119, 1120, 1048, 1045, 1124, 984, 1127, 1116): all clean EXCEPT #1119 and #1120, which conflict in apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx once #982 is in. Pairwise: 982/1119, 982/1120, 1119/1120 all conflict.
- Ratchet along that chain: orders.service.ts 5860 → 5888 (#1090) → 5888 (#1101) → 5905 of 5905 (#1124). invoices.service.ts 6389 of 6415 (#1101 lowers baseline to 6390). ScanInvoiceModal.tsx 3153 of 3159 (#1045). No baseline raised.
- Merge-only file changes (silent-revert heuristic) across the 14 PRs: one — #982 adds a useOrderUiV2 mock line to CreateOrderModal.test.tsx via a merge commit.
- #1090 carries a flag-off test ("a pack-only request reads nothing new ... merge behaviour unchanged") in apps/api/src/orders/orders.create-units.spec.ts. #1101 not checked for the same.
- #1090 origin head still eb57d68b (empty retrigger commit); master-merge unpushed at 23:30Z.

## 23:45Z 2026-09-20, master f9e5a6f9 — remaining writer rows by file (measured by the SA)

- Landed since 7209edae: #1027, #1090 (OrdersService.create now CONVERTED).
- Units rows left: orders.service.ts GUARDED updateOrderItems, approveChangeRequestAtStop, forceConsolidateCustomer, mergeAllPendingForCustomer · invoices.service.ts GUARDED update, duplicate, applyPriceAdjustment + PACK_ONLY_CREATE create (#1101) · PACK_ONLY_CREATE order-templates createOrderFromTemplate, estimates convertToInvoice, import importInvoices.
- Restrictions PENDING 13: orders.service.ts approveChangeRequestAtStop, reopenOrder, mergeAllPendingForCustomer, forceConsolidateCustomer · invoices.service.ts create, update, duplicate, createSplitInvoices · order-templates createOrderFromTemplate · estimates convertToInvoice · import importInvoices · routes.service.ts completeWithPayment, reopenStop.
- Mobile delivery: apps/mobile/Dockerfile:81 `expo export --platform web`, nginx runner; apps/mobile/railway.toml watchPatterns apps/mobile/** and packages/**.

## CHAIN 23:50Z 2026-09-20, master f9e5a6f9

- Reds: #1119 @3463bf40 and #1120 @c90cce41 conflict in CreateOrderModal.tsx after #982 @09314c2b; #951 @17c52aff conflicts in products/[id]/page.tsx. No new reds.
- Ratchet: orders.service.ts 5888 of 5905 (17); #1124 @4920037a → 5905 of 5905 (0). invoices.service.ts 6367 → 6389 of 6415 after #1101 (26). ScanInvoiceModal.tsx 3153 of 3159 after #1045. routes.service.ts 3191 of 3214 (23).
- Schema: OrderTemplateItem and RecurringInvoiceItem show no unit column; EstimateItem has boxes/pieces only (grep of the model blocks; builders confirm).
- Mac capacity (relayed by the lead from Mac Lead, not measured by the SA): 16 GB, memory-bound, one prover + at most two builders.

## CHAIN 01:09Z 2026-09-21, master 4cd486d1

- Landed since f9e5a6f9: #1128 (T6 prerequisite: nested InvoiceItem/ExpenseLineItem creates carry tenantId), #1133 (B620), #1124 (R 2a-8 door edit), #1125, #1117.
- orders.service.ts 5905 of 5905 on master — zero margin.
- Reds: #1119 @3463bf40, #1120 @c90cce41 (CreateOrderModal.tsx after #982); #951 @17c52aff (products/[id]/page.tsx; origin head unchanged); NEW #1132 @1c6b1b82 vs #1116 @dfa67261 (both add apps/api/src/orders/unit-ladder.db.spec.ts).
- Clean in sequence: #1101 (invoices.service.ts 6389 of 6415), #982, #1121 @fd24d2f7, #1048, #1045 (ScanInvoiceModal.tsx 3153 of 3159), #984, #1127 @fc9b94e9, #989 @b4c74c88, #1122, #1129, #1130, #1131, #1134.
- NULL-tenant trace: apps/api/src/prisma/prisma.service.ts tenantTransaction runs `fn(rawTx)` when there is no ambient tenant (fail open). Exposed writers without an explicit tenantId: inventory.service.ts:224, 311, 679, 899, 1395; vendor-bills.service.ts:1061; credit-notes.service.ts:302 (only caller inline-returns.service.ts:389). Seeds cleared: seed-test-catalog.js:760 and demo-seed.js:1592 set the tenant explicitly.

## CHAIN 01:33Z 2026-09-21, master cc283f92

- Reds: #1119 @3463bf40, #1120 @c90cce41 (CreateOrderModal.tsx after #982 @09314c2b). #951 @5378feef now CLEAN: products/[id]/page.tsx 2957 → 2959 of 2967.
- Clean in sequence: #1131 @848adc4e, #1129 @c6c8a8b4, #1135 @04cfcad0, #1101, #982, #1121, #951, #1048, #1045, #984, #1127, #1132, #989, #1130, #1134, #1136 @c01df283. orders.service.ts 5905 of 5905 unchanged by the set. No baseline raised.
- feat/u-orders-extract (lead: 58ca1311, 5905 → 5670, tail → order-lifecycle.ts) not on origin at 01:33Z: unchecked.
- Owner batch: origin ops/t6-a0-owner-batch 3439439e (A0 …210000, T6 …220000/…220100), frozen until step-7 drift is green; 07e00240 is not its ancestor.

## CHAIN 02:36Z 2026-09-21, master f3f8dab4

- Landed since cc283f92: #1136 (code-map catch-up + L-210..L-213), #1048 (PO edit lines table), B635 filing. orders.service.ts still 5905 of 5905 on master.
- #1139 @4adb2f7e (extraction) open: clean alone → 5780, baseline 5780, cap 5805; moves updateShipment, updateFulfillPath, toggleUrgent, applyBuyerMergeHeader, setCommissionRate, bulkDeleteOrders, findOneOrThrow to order-lifecycle.ts. Conflicts with #1101 @f43b13d5 in size-ratchet.spec.ts (pairwise).
- Reds otherwise: #1119 @3463bf40, #1120 @c90cce41. Clean: #1131, #1129, #1135, #982, #1121, #951 @5378feef, #1045, #984, #1127, #1132, #989, #1130, #1134, #1137 (deps bump).
- updateOrderItems = master lines 3081–4767 (1,687 lines); guard call at 3103; transaction opens ~3268; CUSTOMER/DRIVER replace branch ~3285–3485; isStaffEdit ~3515; replaceAll create ~3672–3705. create()'s unit pattern: gate+ladders 5 lines (1832–1836), per-line site ~17 lines (1944–1961).
- 5ea35f04 (lead: U-units 4c-1) is not a ref tip on origin at 02:45Z: unchecked.
