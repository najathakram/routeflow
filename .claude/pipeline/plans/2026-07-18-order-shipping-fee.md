# Plan: Optional shipping fee on orders (order → invoice, end to end)

> Authored by Fable 5 on 2026-07-18. Status: IMPLEMENTED (pipeline wf_6c805dee-e0b clean; verify green x2; 2 fix rounds — incl. a caught-and-fixed replaceAll blocker on fee-only publish)
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone.

## Objective

Add an optional per-order **shipping fee** to RouteFlow. Operators can type a fee when
creating an order (web + mobile) and edit it later (web, staff only). The fee flows onto
the invoice(s) generated from the order (the `Invoice.shippingFee` column and all its
rendering already exist and work), survives every order-edit/reconcile path, and
back-syncs from invoice edits. **The fee is never taxed** — it is added after tax,
matching the existing invoice convention `total = subtotal − discount + shippingFee + taxAmount`.

Groundwork ALREADY DONE (do not redo): `apps/api/prisma/schema.prisma` Order model now has
`shippingFee Decimal @default(0) @db.Decimal(10, 2)`; migration
`apps/api/prisma/migrations/20260728000000_add_order_shipping_fee/migration.sql` exists;
`npx prisma generate` has been run — the TS client already knows `Order.shippingFee`.

## Constraints & conventions

- Monorepo: NestJS API (`apps/api`), Next.js 14 web (`apps/web`), Expo mobile (`apps/mobile`).
- **Money discipline**: every monetary value is wrapped in `roundMoney(...)` (imported in all
  touched files already). Prisma `Decimal` values must be coerced with `Number(...)` before math.
- Prettier: double quotes, semicolons, printWidth 100. Match surrounding comment density/style.
- Tests: Jest, NestJS `Test.createTestingModule`, mocks at the module boundary — extend the
  EXISTING spec files' patterns; no snapshot tests, no new dependencies.
- Do NOT touch `pricing.ts` (any of the 3 mirrors). No new helper — grand totals stay inline.
- Do NOT reformat unrelated code. Targeted edits only.
- The **order-side edit recompute intentionally does NOT subtract `discountAmount`**
  (pre-existing asymmetry, documented in code). Do NOT "fix" it — add the fee only.
- Invariant to preserve everywhere: **`Order.shippingFee == Σ shippingFee of the order's
non-VOID invoices`, to the cent.**
- Fee placement rule for multi-invoice (split) orders: the WHOLE fee goes on exactly ONE
  sibling — the largest-subtotal group (same recipient as the existing tax rounding
  remainder). Never prorated.

## Work packages

### WP1 — API orders: DTOs + all five total-derivation sites + specs

- **files:** `apps/api/src/orders/dto/create-order.dto.ts`,
  `apps/api/src/orders/dto/create-sale.dto.ts`,
  `apps/api/src/orders/dto/update-order-items.dto.ts`,
  `apps/api/src/orders/orders.service.ts`,
  `apps/api/src/orders/orders.service.spec.ts`
- **brief:** Add the optional `shippingFee` DTO field (create / sale / update-items), thread
  it through order creation, and make every one of the FIVE places that re-derive the order
  total read the stored fee. Missing any one silently zeroes the fee on that path.

1. **DTOs** — mirror the existing `discountAmount` field exactly (same decorators, adjacent
   placement). In `create-order.dto.ts` (next to `discountAmount`, ~line 66),
   `create-sale.dto.ts` (~line 46), and `UpdateOrderItemsDto` in `update-order-items.dto.ts`
   (top-level class, alongside `orderNotes`):

   ```ts
   /** Optional flat shipping fee added to the order total (never taxed). */
   @IsOptional()
   @IsNumber()
   @Min(0)
   @Max(1_000_000)
   shippingFee?: number;
   ```

2. **`create()` (orders.service.ts ~1324-1333)** — current code:

   ```ts
   subtotal = roundMoney(subtotal);
   const orderDiscount = dto.discountAmount ?? 0;
   const tax = roundMoney(subtotal * (await this.getTaxRate()));
   const categoryTax = roundMoney(
     lineItemsData.reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
   );
   const total = roundMoney(subtotal + tax + categoryTax - orderDiscount);
   ```

   becomes:

   ```ts
   subtotal = roundMoney(subtotal);
   const orderDiscount = dto.discountAmount ?? 0;
   // Optional shipping fee — never taxed; added after tax like Invoice.shippingFee.
   const orderShippingFee = roundMoney(Math.max(0, dto.shippingFee ?? 0));
   const tax = roundMoney(subtotal * (await this.getTaxRate()));
   const categoryTax = roundMoney(
     lineItemsData.reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
   );
   const total = roundMoney(subtotal + tax + categoryTax - orderDiscount + orderShippingFee);
   ```

   And in the `tx.order.create({ data: { ... } })` (~1422-1440), add
   `shippingFee: orderShippingFee,` directly under `discountAmount: orderDiscount,`.

3. **`createSale()`** — locate where it forwards its dto into `this.create(...)` (it already
   forwards `discountAmount`); forward `shippingFee: dto.shippingFee` the same way.

4. **Merge recomputes** — two sites that rebuild the winner's totals after merging orders.
   Site A `mergeIntoWinner` (~line 729-738) and site B `forceConsolidateCustomer` (~943-953).
   Both currently write `total: roundMoney(subtotal + tax + categoryTax)`. Change both to:

   ```ts
   // Winner keeps ITS OWN stored fee; loser fees drop with the losers (the merged
   // order is one delivery → one fee). Same asymmetry as discountAmount.
   total: roundMoney(subtotal + tax + categoryTax + Number(winner.shippingFee ?? 0)),
   ```

   (`winner` is a full Prisma row in both scopes — `shippingFee` is available. If TS
   complains about the type, coerce via `(winner as any).shippingFee`.)

5. **`updateOrderItems()` recompute (~2406-2467)** — the main edit path. Current:

   ```ts
   const categoryTax = await this.recomputeLineCategoryTaxes(tx, activeItems);
   const total = roundMoney(subtotal + tax + categoryTax);
   ```

   becomes:

   ```ts
   const categoryTax = await this.recomputeLineCategoryTaxes(tx, activeItems);
   // Staff may set/change the fee on edit; everyone else keeps the stored fee.
   // Reading the STORED fee here is what stops an ordinary item edit from
   // silently zeroing shipping (the fee-wipe regression).
   const isStaffFeeEdit =
     (user?.role === UserRole.OPERATOR || user?.role === UserRole.TENANT_ADMIN) &&
     dto.shippingFee !== undefined;
   const shippingFee = isStaffFeeEdit
     ? roundMoney(Math.max(0, dto.shippingFee!))
     : roundMoney(Number((order as any).shippingFee ?? 0));
   const total = roundMoney(subtotal + tax + categoryTax + shippingFee);
   ```

   In the `tx.order.update({ data: { ... } })` (~2451-2466) add
   `...(isStaffFeeEdit ? { shippingFee } : {}),` after `total,`.
   IMPORTANT: `order` is fetched near the top of `updateOrderItems` — if that fetch uses a
   `select`, add `shippingFee: true` to it; if it's a full include-row, nothing to do.
   The credit-limit guard call (`assertWithinCreditLimit(..., total)`) stays as-is — the fee
   now counts against credit limits (intended).

6. **`resolveChangeRequest` recompute (~3138-3154)** — change
   `const total = roundMoney(subtotal + tax + categoryTax);` to

   ```ts
   const total = roundMoney(subtotal + tax + categoryTax + Number((order as any).shippingFee ?? 0));
   ```

7. **Revision snapshots** — grep `appendOrderRevision` call sites in orders.service.ts; where
   a snapshot object includes `subtotal`/`total`/`discountAmount`-style money fields, add
   `shippingFee` (snapshot is Json — additive, no schema change). Skip call sites that don't
   snapshot money.

8. **Specs (`orders.service.spec.ts`)** — extend existing describe blocks / mock patterns.
   New cases (names indicative):
   - create with `shippingFee: 5` → `order.create` data contains `shippingFee: 5` and
     `total = roundMoney(subtotal + tax + categoryTax − discount + 5)`.
   - create without `shippingFee` → data has `shippingFee: 0` and totals are byte-identical
     to the pre-feature formula (regression lock).
   - create with fee + discount combined → both applied.
   - **edit preserves fee**: `updateOrderItems` with NO `dto.shippingFee` on an order whose
     stored `shippingFee` is 7 → the recomputed total includes +7 and `order.update` data
     does NOT contain a `shippingFee` key. (The single most important spec.)
   - staff edit sets fee: OPERATOR with `dto.shippingFee: 3` → total includes +3, update data
     contains `shippingFee: 3`. CUSTOMER role with `dto.shippingFee: 3` → ignored (stored fee
     used, no `shippingFee` key in update data).
   - credit-limit guard receives the fee-inclusive total (assert the mock's call arg).

### WP2 — API invoices: fee seeding, reconcile stability, back-sync + specs

- **files:** `apps/api/src/invoices/invoices.service.ts`,
  `apps/api/src/invoices/invoices.service.spec.ts`
- **brief:** Replace the two hardcoded `shippingFee: 0` from-order creation sites with
  remaining-fee seeding; make the two rebuild paths carry the order fee; make the backward
  sync write `Order.shippingFee`. All arithmetic `roundMoney`-wrapped.

1. **`createSplitInvoices` (~697-810)** — `groupData` construction (~702-716): add
   `shippingFee: 0,` to the per-group object literal (next to `regularTax: 0, taxAmount: 0, total: 0`).
   After the regular-tax allocation block (ends ~743) and BEFORE the
   `groupData.forEach((gd) => { gd.taxAmount = ...; gd.total = ...; })`, insert:

   ```ts
   // Order-level shipping fee: the WHOLE remaining fee rides on exactly ONE
   // sibling — the largest-subtotal group (same recipient rule as the tax
   // rounding remainder). Never prorated, so Σ(sibling totals) still equals the
   // order total to the cent. "Remaining" defends against re-entry when some
   // non-void invoice for this order already carries fee dollars.
   const orderFee = roundMoney(Number((order as any).shippingFee ?? 0));
   if (orderFee > 0 && groupData.length > 0) {
     const priorFeeAgg = await db.invoice.aggregate({
       where: { orderId: order.id, status: { not: InvoiceStatus.VOID } },
       _sum: { shippingFee: true },
     });
     const feeRemaining = Math.max(
       0,
       roundMoney(orderFee - Number(priorFeeAgg._sum.shippingFee ?? 0)),
     );
     if (feeRemaining > 0) {
       let feeIdx = 0;
       for (let i = 1; i < groupData.length; i++)
         if (groupData[i].subtotal > groupData[feeIdx].subtotal) feeIdx = i;
       groupData[feeIdx].shippingFee = feeRemaining;
     }
   }
   ```

   Then change the totals line to `gd.total = roundMoney(gd.subtotal + gd.taxAmount + gd.shippingFee);`
   and in the `tx.invoice.create` data change `shippingFee: 0,` → `shippingFee: gd.shippingFee,`.
   NOTE this runs for tax-exempt customers too (it is OUTSIDE the isTaxExempt branch — that
   is deliberate; exempt customers still pay shipping).

2. **Partial-from-order create (~1794-1844)** — the second `shippingFee: 0` site. Before
   `const total = roundMoney(subtotal + taxAmount);` insert the same remaining-fee
   computation (no groups here — the single new invoice takes the whole remainder):

   ```ts
   // First partial carries the whole remaining order fee; later partials get 0.
   const orderFee = roundMoney(Number((order as any).shippingFee ?? 0));
   let feeRemaining = 0;
   if (orderFee > 0) {
     const priorFeeAgg = await this.prisma.forTenant().invoice.aggregate({
       where: { orderId: order.id, status: { not: InvoiceStatus.VOID } },
       _sum: { shippingFee: true },
     });
     feeRemaining = Math.max(0, roundMoney(orderFee - Number(priorFeeAgg._sum.shippingFee ?? 0)));
   }
   const total = roundMoney(subtotal + taxAmount + feeRemaining);
   ```

   and in the create data: `shippingFee: feeRemaining,`.

3. **`reconcileOrderDraftInvoice` (~850-945)** — currently preserves the draft's own fee:

   ```ts
   const total = roundMoney(
     subtotal - Number(draft.discount ?? 0) + Number(draft.shippingFee ?? 0) + taxAmount,
   );
   ```

   Replace with order-as-source-of-truth (order-driven reconciles overwrite the draft fee;
   invoice-side fee edits still work because the invoice `update()` path back-syncs
   `Order.shippingFee` first — see item 5):

   ```ts
   // Order-driven reconcile: the ORDER owns the fee. Subtract fee dollars already
   // carried by OTHER non-void invoices of this order (split/partial siblings) so
   // Σ(invoice fees) == order.shippingFee stays exact.
   const otherFeeAgg = await db.invoice.aggregate({
     where: { orderId, status: { not: InvoiceStatus.VOID }, id: { not: draft.id } },
     _sum: { shippingFee: true },
   });
   const draftFee = Math.max(
     0,
     roundMoney(
       Number((order as any).shippingFee ?? 0) - Number(otherFeeAgg._sum.shippingFee ?? 0),
     ),
   );
   const total = roundMoney(subtotal - Number(draft.discount ?? 0) + draftFee + taxAmount);
   ```

   and add `shippingFee: draftFee,` to the `db.invoice.update({ data: { ... } })` (~910-919).

4. **`rebuildSiblingDrafts` (~1116-1236)** — add `shippingFee: 0,` to the `perDraft` object
   literal (~1144-1154). Then replace the totals forEach (~1173-1182) with:

   ```ts
   // Sibling fee placement. If the current sibling fees already sum to the order
   // fee, keep each sibling's own placement (an operator may have moved the fee
   // to a specific sibling via an invoice edit — that edit back-synced the order,
   // so the sums agree). On mismatch (the fee changed on the order side) re-seed
   // the whole fee onto the largest-subtotal sibling and zero the rest — mirrors
   // createSplitInvoices.
   const orderFee = roundMoney(Number(order.shippingFee ?? 0));
   const currentFeeSum = roundMoney(
     perDraft.reduce((s, pd) => s + Number(pd.draft.shippingFee ?? 0), 0),
   );
   if (currentFeeSum === orderFee) {
     perDraft.forEach((pd) => {
       pd.shippingFee = roundMoney(Number(pd.draft.shippingFee ?? 0));
     });
   } else {
     let maxIdx = 0;
     for (let i = 1; i < perDraft.length; i++)
       if (perDraft[i].subtotal > perDraft[maxIdx].subtotal) maxIdx = i;
     perDraft.forEach((pd, i) => {
       pd.shippingFee = i === maxIdx ? orderFee : 0;
     });
   }
   perDraft.forEach((pd) => {
     pd.taxAmount = roundMoney(pd.regularTax + pd.categoryTax);
     pd.total = roundMoney(
       pd.subtotal - Number(pd.draft.discount ?? 0) + pd.shippingFee + pd.taxAmount,
     );
   });
   ```

   and add `shippingFee: pd.shippingFee,` to the `db.invoice.update({ data: { ... } })`
   (~1206-1217). The preserveStatus `recomputeStatus(paid, pd.total, ...)` already consumes
   the fee-inclusive total — no change there.

5. **`recomputeOrderFromInvoices` (~1485-1633, the backward sync)** — the `invoices`
   findMany (~1493) returns full rows (fee included). Change the tail (~1623-1632):

   ```ts
   subtotal = roundMoney(subtotal);
   const prevSubtotal = Number(order.subtotal) || 0;
   const effectiveTaxRate = prevSubtotal > 0 ? Number(order.tax) / prevSubtotal : 0;
   const tax = roundMoney(subtotal * effectiveTaxRate);
   const categoryTax = roundMoney(categoryTaxSum);
   // Shipping back-sync: the order's fee is DEFINED as Σ(non-void invoice fees) —
   // an invoice-side fee edit lands here and updates the order, which is what
   // lets the order-driven reconciles treat the order as source of truth.
   const shippingFeeSum = roundMoney(
     invoices.reduce((s: number, inv: any) => s + Number(inv.shippingFee ?? 0), 0),
   );
   const total = roundMoney(subtotal + tax + categoryTax + shippingFeeSum);
   await db.order.update({
     where: { id: orderId },
     data: { subtotal, tax, total, shippingFee: shippingFeeSum },
   });
   return { orderId, subtotal, tax, total, shippingFee: shippingFeeSum };
   ```

6. **Specs (`invoices.service.spec.ts`)** — extend existing patterns:
   - `createInvoiceFromOrder` single group on an order with `shippingFee: 6` → created
     invoice has `shippingFee: 6`, `total = subtotal + taxAmount + 6`.
   - split (two groups) → fee lands on exactly the LARGEST-subtotal sibling, other sibling 0,
     and Σ(sibling totals) == order total to the cent. Include a tax-exempt-customer variant
     (fee still placed).
   - `reconcileOrderDraftInvoice` seeds the draft's fee from the order (draft had a stale
     value; order fee wins).
   - `rebuildSiblingDrafts` stability: sibling fees {6,0} with order fee 6 → placement kept;
     order fee changed to 9 → re-seeded {9,0} on the largest sibling.
   - `recomputeOrderFromInvoices` sums non-void invoice fees onto `Order.shippingFee` +
     total; a VOID sibling's fee is excluded.
   - partial-from-order: first partial carries the whole fee; a second partial (prior
     invoice already carries it) gets 0.

### WP3 — Web: order form, order detail, API types, e2e money-guard

- **files:** `apps/web/lib/api/orders.ts`,
  `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`,
  `apps/web/app/(dashboard)/orders/[id]/page.tsx`,
  `apps/web/e2e/06-critical-paths.spec.ts`
- **brief:**

1. `lib/api/orders.ts`: add `shippingFee?: number | string;` to the `Order` interface (next
   to `discountAmount`); add `shippingFee?: number;` to the create-order mutation DTO, the
   `CreateSaleDto`, and the `useUpdateOrderItems` variables type + PATCH body pass-through
   (mirror how `discountAmount`/`orderNotes` flow).
2. `CreateOrderModal.tsx`: find the existing order-discount state/input (state ~line 328,
   summary input near the totals block ~1604-1609, payload spread ~833). Clone the pattern:
   - `const [shippingFeeInput, setShippingFeeInput] = React.useState("");`
   - `const shippingAmt = Math.max(0, parseFloat(shippingFeeInput) || 0);`
   - display total (~349): append `+ shippingAmt` (keep `− discountAmt`).
   - a "Shipping fee" labeled number input rendered immediately after the discount input,
     same styling/markup, placeholder "0.00 (optional)".
   - a conditional `Shipping` summary row (only when `shippingAmt > 0`) next to the existing
     Subtotal/Discount rows.
   - payload: `...(shippingAmt > 0 ? { shippingFee: shippingAmt } : {}),` in BOTH the
     create-order payload and the bill-now/createSale payload if the modal has one.
3. `orders/[id]/page.tsx`:
   - `const shippingFee = Number((order as any).shippingFee ?? 0);` near the other derived
     money values.
   - read view: in the totals breakdown (~2583-2600, rows Subtotal / Tax / Regulated tax /
     Order total) insert a `Shipping` row between Regulated-tax and Order-total, rendered
     only when `shippingFee > 0`, markup mirroring the Regulated-tax row.
   - edit mode: the edit-total memo (~1658-1675, `editSubtotal + editTax + orderCategoryTax`)
     appends `+ editShippingFee` where `editShippingFee` is new state initialized from
     `Number(order.shippingFee ?? 0)` when edit mode opens; render a small "Shipping fee"
     number input in the edit toolbar/summary area; include `shippingFee: editShippingFee`
     in the `updateItems.mutate(...)` payload ONLY when the value differs from the stored
     one (avoids no-op churn). This page is operator-only, so no client role check needed.
4. `e2e/06-critical-paths.spec.ts`: two assertions currently enforce `total ≈ subtotal + tax`:
   - CP-10 (~400-404): destructure `const { subtotal = 0, taxAmount = 0, total = 0, discount = 0, shippingFee = 0 } = detail;`
     (coerce with `Number(...)` if the fields are strings) and assert
     `Math.abs(total - (subtotal - discount + shippingFee + taxAmount)) < 0.011`.
   - CP-03 (~203): it parses rendered rows — extend the parser to read optional
     "Shipping" and "Discount" rows (default 0 when absent) and assert the same formula.
     Keep tolerance/rounding style consistent with the current assertions.

### WP4 — Mobile: types, create form, detail rows, invoice shipping-row gap

- **files:** `apps/mobile/lib/api/orders.ts`, `apps/mobile/lib/api/invoices.ts`,
  `apps/mobile/components/NewOrderScreen.tsx`,
  `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`,
  `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`
- **brief:**

1. `lib/api/orders.ts`: add `shippingFee?: number | string;` to the Order type and
   `shippingFee?: number;` to the create-order DTO type(s) (mirror `discountAmount`).
2. `lib/api/invoices.ts`: add `shippingFee?: number | string;` to the Invoice type (next to
   `discount`).
3. `NewOrderScreen.tsx`: the discount input parses at ~833 (`Math.max(0, parseFloat(discountRaw))`)
   and is sent at ~845 via `...(discountAmount > 0 ? { discountAmount } : {})`. Clone for a
   "Shipping fee" input rendered next to/below the discount input (same visual pattern), and
   `...(shippingFee > 0 ? { shippingFee } : {})` in the same payload. Keep the footer total
   display unchanged EXCEPT add an informational "Shipping" line when the fee > 0 (do not
   change what the footer total means — mirror how discount is displayed today; if discount
   isn't folded into the footer total, don't fold shipping either).
4. `orders/[id].tsx` (operator order detail): the totals block renders Subtotal / Tax /
   Regulated tax rows — add a `Shipping` row (only when `Number(order.shippingFee) > 0`),
   formatted with the same currency helper used by its siblings.
5. `invoices/[id].tsx` (operator invoice detail): PRE-EXISTING GAP — the screen renders a
   discount block (~431-437) but NO shipping row even though invoices carry `shippingFee`.
   Add, right after the discount block:
   ```tsx
   {Number(invoice.shippingFee ?? 0) > 0 && (
     /* same row markup as the discount block, label "Shipping",
        value formatted with the file's existing currency formatter */
   )}
   ```
   Match the exact row component/styles used by the discount block in that file.

## Acceptance criteria

1. `CreateOrderDto`, `CreateSaleDto`, `UpdateOrderItemsDto` each accept optional
   `shippingFee` (number, min 0, max 1,000,000); invalid values are rejected by validation.
2. Order create persists `shippingFee` and `total = roundMoney(subtotal + tax + categoryTax − discountAmount + shippingFee)`.
3. All four re-derivation sites (mergeIntoWinner, forceConsolidateCustomer, updateOrderItems,
   resolveChangeRequest) include the stored `Order.shippingFee` in the recomputed total; an
   item edit with no `dto.shippingFee` leaves the stored fee and its contribution intact.
4. Only OPERATOR/TENANT_ADMIN can change the fee via `updateOrderItems`; other roles' dto
   values are ignored.
5. From-order invoice creation seeds `Invoice.shippingFee` from the order: single invoice
   gets the whole fee; split invoices put the whole fee on the largest-subtotal sibling
   (others 0); Σ(sibling totals) == order total exactly; works for tax-exempt customers.
6. `reconcileOrderDraftInvoice` and `rebuildSiblingDrafts` write fee-inclusive totals and
   maintain Σ(invoice fees) == order fee (stability rule on match, re-seed on mismatch).
7. `recomputeOrderFromInvoices` writes `Order.shippingFee = Σ non-void invoice fees` and a
   fee-inclusive order total; VOID invoices excluded.
8. Web: create modal has a shipping-fee input whose value reaches the API; order detail
   shows a Shipping row when fee > 0; edit mode can change the fee (staff page).
9. Mobile: create screen sends the fee; order detail + invoice detail show Shipping rows
   when > 0.
10. e2e CP-03/CP-10 assert `total == subtotal − discount + shippingFee + taxAmount`.
11. No changes to pricing.ts mirrors, no new dependencies, no unrelated reformatting.

## Verification commands

- `npm run verify` (repo root — typecheck + lint + Jest for api and mobile; this is the
  repo's standing gate)

## Risks & rollback

- **Fee-wipe regression**: any missed total re-derivation site zeroes the fee. The five API
  sites are enumerated in WP1/WP2; reviewers should grep `subtotal + tax` in
  `apps/api/src` and confirm every hit is either updated or genuinely fee-free.
- **Split-cent drift**: fee must be added to exactly one sibling; prorating breaks
  Σ(siblings) == order total.
- **Back-sync loop**: order-driven reconcile overwrites invoice fees from the order; the
  invoice `update()` path back-syncs the order first via `recomputeOrderFromInvoices`. The
  stability rule in rebuildSiblingDrafts (keep placement when sums match) prevents
  ping-pong.
- Rollback: revert the app commit; the DB column is additive with default 0 and harmless
  if unread.
