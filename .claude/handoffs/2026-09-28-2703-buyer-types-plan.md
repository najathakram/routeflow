# #2703 buyer types → @routeflow/types — findings + scope question (U-units, 2026-09-28)

Branch `types/2703-buyer-types` @ origin/master 1cd9c712 (rf-mac-driver-2029). Claimed: #2703 comment 5875086262. No code yet.

## Finding: web and mobile shapes DIVERGE — "shapes unchanged" is not possible with one declaration
Server truth read from apps/api (buyer-catalog.service.ts:15/200/393/483; orders.service.ts findAll :326 / findOne :408;
invoices.service.ts findOne :2981).

- **BuyerProduct**: mobile carries dead fields never sent (`price`, `basePrice`, `imageUrl`, `isFavorite`) and marks
  always-sent fields optional; web is close to server (`imageKeys`, `buyerPrice` required). Server `imageUrls`, `isNew`,
  `isDeal`, stock fields always sent.
- **Favorites mis-type (mobile)**: `useBuyerFavorites` is typed `BuyerProduct[]` but `GET /buyer/favorites` returns a
  different shape (`id` = favorite row id, `productId`, `thumbnailUrl` always null, `createdAt`); favorites.tsx works around
  it with `idOf`/`priceOf`. Web already has the right `BuyerFavoriteItem` (web buyer.ts:613).
- **BuyerOrder**: list (findAll: thin product, `_count.changeRequests`, no editWindow) ≠ detail (findOne: invoices,
  changeRequests[], routeRun, editWindow, rich product). Mobile = one type, detail-only optional (fits). Web = detail-only
  `BuyerOrder` + separate `BuyerOrderListItem` (whose `itemCount`/`totalAmount` the server never sends; null-guarded).
  - web types `orderNumber: string` but Prisma `orderNumber String?` — 3 unguarded renders in web orders/[id]/page.tsx (:664,:1060,:1073).
  - web lacks `categoryTaxAmount`, `unitLabel` on lines; mobile lacks `priceType`, `originalPrice`, `name`, `customer`.
- **BuyerInvoiceItem / BuyerInvoicePayment**: web has no named types (inline in `BuyerInvoiceDetail`, web buyer.ts:511);
  web item lacks boxes/pieces/unitLabel/promoFreeUnits/notes/priceType/msrp; both lack trackedCategory, creditNote;
  mobile `paymentMethod` fallback is dead (server field is `method`).
- Buyer-facing **ChangeRequest** (mobile buyer.ts local vs web lib/change-requests): field-identical → safe to share.
  Mobile's driver-flow ChangeRequest (lib/api/change-requests.ts) is narrower and stays separate.
- Decimal fields may arrive as strings (Prisma Decimal.toJSON) — pre-existing project-wide; out of scope.

## Options (for the SA)
- **A (recommended) server-truth**: one declaration per type = what the API sends (optional where list/detail differ),
  dead fields dropped; add `BuyerFavoriteProduct` (web's BuyerFavoriteItem moves too) and fix mobile favorites' typing
  (+ drop its dead fallbacks); share buyer ChangeRequest; web invoice detail uses the shared item/payment types;
  web `orderNumber` becomes `string | null` → guard the 3 renders (`?? ""`-style, no visible change for real orders).
  Type-level only otherwise; check-types across web/mobile/api decides the consumer edit list.
- **B loose union**: merge both shapes, every divergent field optional — zero behaviour change, fewest edits, but
  bakes in dead/wrong fields (the L-072 pattern this issue exists to remove).
- Either way web `BuyerOrderListItem` stays (not one of the four names) unless the SA wants it folded (ASK).

## Carry-overs (2026-09-28, U-units)
- #2696(c) + the "cases+" wording: MOVED to Lane B (#2715 owns PriceEditor/LineItemRow) — not mine.
- #2703 order family WIP at 9a50c3cf (local, on 214abdfb) waits for B889 (client-only; repro #2554 5876190546).

## B891 (root fix, lead scope 2026-09-28) — pre-scan at master 14563406
- Label-derived default ids (id ?? label.toLowerCase().replace(/\s+/g,"-")): packages/ui/src/web/{Input.tsx:15, Select.tsx:24, Textarea.tsx:15, PasswordInput.tsx:19}; apps/web/components/AddressAutocomplete.tsx:56 (no id override at all).
- Fix: default to React.useId() when no id; explicit id wins. Symptom pin: InlineReturnSection lines; red-first pin: two same-labelled Inputs.
- Id-based consumers to verify (explicit id vs label-derived) at implementation: e2e #delivery-date / #order-date (56, 08), #reauth-pw (07); getElementById("password") login/page.tsx:258, ("buyer-password") buyer/login:135, ("payments-search") finance/payments:525. #main-content/#trip-stop/#bar/#ai-heading are not Input-derived.
- Mac Lead 2026-09-28: INCLUDE AddressAutocomplete.tsx:56. Every derived-id consumer (login:258 "password", buyer login:135 "buyer-password", payments:525 "payments-search", e2e #delivery-date/#order-date/#reauth-pw) gets an EXPLICIT id at its call site in the SAME PR; an RTL/unit pin per auth consumer that the element is found; list every touched consumer in the PR body. PC F-prover smoke: staff login + buyer login + reauth + a repeated-row form.

## #2710 (lead 2026-09-28): observe, don't predict
In slot: (1) buyer GET after deactivating the line's catalog product → product present; (2) operator DELETE on the referenced product → refused; (3) web buyer edit shows the line. All hold ⇒ CLOSE #2710 "not reproducible" with the request/response bodies + the refusal. NO hardening, NO fold into B891; the web filter stays.

## #2722 (local 03162f02 on types/2722-payment-method, stacked on #2725 @847f3cac) — PR-body consumer inventory
- api: every `PaymentMethod` import (12 files) is `@prisma/client`; every value use `PaymentMethod.X` (routes/credit-notes/vendor-bills/supplier-statements/supplier-payment.spec) is Prisma's → the removed legacy TS enum in packages/types/index.ts had ZERO consumers.
- web: lib/payment-methods.ts ← @routeflow/types (type only). mobile: lib/payment-methods.ts + lib/run-settlement.ts ← @routeflow/types (type only); lib/api/invoices.ts `export type PaymentMethod = AnyPaymentMethod` (alias → shared); lib/api/payments.ts, lib/payments-logic.ts, __tests__/payments-helpers.test.ts ← ./api/invoices alias.
- In slot: merge master (after #2725) → red (source scan on 847f3cac's payment-methods/run-settlement/settlement: 4 sites) → green → full verify → push → PR (base master) with this inventory.
