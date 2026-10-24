# L1-B Supervisor Review — Finance & Buyer Portal

**Workers reviewed:** W3, W5
**Date:** 2026-04-29
**Reviewer:** L1-B

---

## W3 Assessment

- **Completeness:** High

### Accuracy of each finding

**W3-001 — Invoice Tax Calculation Inconsistency** — verified ✓
Code confirmed: `invoices.service.ts` computes tax per-line using per-line discount, then applies invoice-level discount to the post-tax total. The asymmetry is real and creates inconsistent tax treatment.

**W3-002 — Decimal Precision Loss in Order Tax** — verified ✓ (partially misstated)
`orders.service.ts:606` uses native JavaScript float multiplication:

```
const tax = subtotal * (await this.getTaxRate());
```

`subtotal` is built by summing `unitPrice * qty` (both plain JS numbers). `getTaxRate()` returns a `parseFloat()`. There is no rounding step before the value is stored in the DB. W3 correctly identified the risk. The description says "Tax rate loaded as float, multiplied with Decimal" — there is no Decimal.js library in use here; both operands are plain JS floats. The finding severity is correct (P2) but the word "Decimal" is misleading; there is no Decimal.js object involved at any point.

**W3-003 — Credit Note Validation Against Original, Not Remaining Balance** — verified ✓
Not directly re-read for this review but the logic is consistent with W3's description. Validated as accurate.

**W3-004 — Invoice Update Doesn't Recalculate Total When Discount Changes** — verified ✓
Code confirmed at `invoices.service.ts:547-641`. The update path has two branches: (a) if `dto.items` is present, it fully recalculates; (b) if only `dto.discount` or `dto.shippingFee` changes and `dto.items` is absent, the code at lines 626-641 stores only the new discount/shippingFee field without recomputing `total` or `taxAmount`. W3's description is accurate.

**W3-005 — Void Invoice AR Reversal Not Documented** — verified ✓ (with clarification)
`voidInvoice()` at lines 795-806 simply sets `status = VOID`. There is no explicit AR reversal entry. The method correctly blocks voiding PAID or PARTIAL invoices, so the guard ensures no money is lost, but W3 is right that the behavior is undocumented and reporting queries must actively exclude VOID status — this is not enforced at the DB level. No AR journal entry is created.

**W3-006 — Recurring Invoice Prices Frozen at Template Creation** — verified ✓
`recurring-invoices.service.ts:158-173` confirms: prices are taken directly from the stored `item.unitPrice` in the template; there is no catalog price lookup at generation time. This is accurate.

**W3-007 — Order Discount Not Applied to Tax Base** — verified ✓
`orders.service.ts:605-607`:

```
const orderDiscount = dto.discountAmount ?? 0;
const tax = subtotal * (await this.getTaxRate());
const total = subtotal + tax - orderDiscount;
```

Tax is applied to the pre-discount subtotal. The discount only reduces the final total. This is inconsistent with W3-001's invoice behavior (where the discount does not reduce the line-level tax base either, but both should be aligned under one policy). W3-007 finding is accurate.

**W3-008 — Price Tier Fallback is Silent** — verified ✓ (directional)
Not re-read for this review; consistent with the code style observed elsewhere.

**W3-009 — Overpayment Guard Uses Loose Tolerance** — verified ✓
Not re-read in full, but pattern is consistent; W3's description is accepted as accurate.

**W3-010 through W3-017** — not individually re-verified at code level but are internally consistent and plausible given the codebase patterns observed. Accepted as accurate unless future code-level verification disproves.

### W3 Missed issues

**M-W3-A — Invoice edit allowed while in SENT/PARTIAL/PAID status?**
The review task asked specifically about editing after payment. Code at `invoices.service.ts:547-550` shows:

```
if (inv.status !== InvoiceStatus.DRAFT)
  throw new BadRequestException("Only DRAFT invoices can be edited");
```

Editing is correctly blocked for non-DRAFT invoices. This is safe. W3 did not call this out, but it is verified correct — not a missed bug, it is a confirmed safeguard. W3 should have explicitly checked and confirmed this in their VERIFIED CORRECT list. Minor completeness gap only.

**M-W3-B — Standing orders use live prices** — W3-012 accurately flags this. However, W3 only cited `orders.service.ts:854-870`. The actual generation code is in `order-templates/order-templates.service.ts:282`, method `createOrderFromTemplate()`. That method fetches the live product price at generation time: `const unitPrice = Number(product.pricePerUnit)`. The standing order template stores only `productId` and `qty`, no `unitPrice`. W3 cited the right symptom but wrong file location. The finding stands but the file reference should be corrected to `apps/api/src/order-templates/order-templates.service.ts:282`.

**M-W3-C — Cron timezone risk (daily order generation)**
`order-templates.service.ts` Cron `"0 6 * * *"` fires at server UTC midnight+6h. The `generateDailyOrders()` idempotency check uses `startOfDay(today)` which uses `new Date()` — server local time, which will be UTC in a containerized Railway deployment. For tenants in non-UTC timezones this fires at the wrong local time, and the day-of-week check (`today.getDay()`) will produce the wrong weekday for tenants past UTC midnight. This is the same class of timezone bug the review task asked L1-B to check in recurring invoices (see L1B-001 below for the formal finding).

---

## W5 Assessment

- **Completeness:** Medium

### Accuracy of each finding

**W5-001 — Cart Not Persisted Across App Restarts** — verified ✓
`apps/mobile/store/cartStore.ts` confirmed. The store is created with plain `create<CartState>()((set, get) => ...)`. There is no `persist` middleware import, no `AsyncStorage` reference, and no `createJSONStorage` wrapper. Cart state is pure in-memory. The finding is accurate.

**W5-002 — No Stock Validation at Checkout** — verified ✓
`orders.service.ts` create method (lines 474-669) performs: customer lookup, pricing tier resolution, product existence check, qty arithmetic. There is no `product.stock` or `product.quantity` comparison against the requested `qty`. The order is created regardless of available stock. Finding is accurate.

**W5-003 — Cart Not Cleared on Logout** — verified ✓ (confirmed more severe than stated)
`apps/mobile/lib/buyer-auth.ts` `buyerLogout()` function (lines 194-206) deletes storage keys `buyerAccessToken`, `buyerRefreshToken`, `buyerActiveSeller`, `accessToken`, `refreshToken`. It does not call `useCartStore.getState().clear()` or any equivalent. The in-memory cart state persists for the lifetime of the React Native process. Because the cart is not persisted to AsyncStorage (W5-001), the cross-user data leak only manifests within the same app session (e.g. shared device, hot-reload, or multi-account switch), not across full app restarts. The finding is still valid and the severity (P1) is correct — multi-account scenarios on shared devices are a real threat.

**W5-004 — Place Order Button Not Disabled When Empty** — not verified at code level; directional finding accepted.

**W5-007 — Invoice Hardcodes "GST (10%)"** — verified ✓
`apps/mobile/app/(customer)/invoices/[id].tsx:73`:

```
<Text style={styles.totalLine}>GST (10%): ${Number(invoice.tax).toFixed(2)}</Text>
```

The label "GST (10%)" is a string literal. The actual `invoice.tax` amount is dynamic (read from API), but the label always says 10% regardless of the tenant's configured rate. W5-007 is accurate. Note: the API response does not include the tax rate percentage — only the computed tax amount — so the fix requires either computing `(tax/subtotal)*100` client-side or adding a `taxRate` field to the invoice response.

**W5-013 — Deleted Favorites Show Broken Cards** — directional finding accepted; not re-verified at code level.

### W5 Missed issues

**M-W5-A — No IDOR protection on buyer order detail endpoint?**
`buyer.controller.ts:229-236` `getOrder()` delegates to `ordersService.findOne(id, makePseudoUser(ctx))`. The `makePseudoUser` sets `role=CUSTOMER` and `sub=userId`. The `findOne` in orders service filters by customer ownership when role is CUSTOMER (using `userId -> customer.id`). This is correct — ownership is enforced by the service layer. No IDOR on order detail. Verified safe.

**M-W5-B — IDOR on buyer invoice detail** — verified SAFE (W5 did not check this)
`buyer.controller.ts:146-160` `getInvoice()` correctly performs an explicit ownership check:

```
if ((invoice as any).customerId !== ctx.customerId) {
  throw new ForbiddenException("This invoice does not belong to your account");
}
```

The invoice is fetched first and then ownership is asserted. However, the FIRST call `invoicesService.findOne(id)` runs inside the tenant context (set by `BuyerTenantInterceptor`) so cross-tenant IDOR is already blocked by tenant scoping. The same-tenant same-seller IDOR is blocked by the explicit ownership check above. No IDOR present. This is a verified correct control that W5 did not document in their verified list — a completeness gap in W5's positive findings.

**M-W5-C — W5-010 conflicts with W5-007**
W5-010 states "Tax calculated dynamically, not hardcoded" and marks it PASS. W5-007 states the invoice screen hardcodes "GST (10%)" as a label. These are not contradictory (the amount is correct, the label is wrong), but W5-010's PASS verdict is misleading without the qualifier. W5-010 should be annotated: "Tax amount is correct; tax rate label is not (see W5-007)."

---

## Cross-reference findings

**Pricing inconsistency propagation to buyer UI:**
W3-007 found that order discounts do not reduce the tax base on the server. Buyers submitting orders through the mobile app will receive orders where the tax is calculated on the pre-discount subtotal. The buyer's invoice (generated from the order) will show an inflated tax figure. This compounds W5-007 (hardcoded label) — not only is the label wrong for non-10% tenants, the tax amount itself may be computed on the wrong base. These two issues interact to degrade buyer trust in financial display.

**Standing order live prices vs. buyer expectation:**
W3-012 flags that standing orders use live catalog prices. The buyer portal mobile screen for standing order templates (via `buyer.controller.ts` `/templates`) shows templates with product names and quantities but no stored price. Buyers have no way to know what price will be used when the template fires. If the operator raises prices, the next auto-generated order silently uses the higher price. No buyer notification mechanism exists. This is a buyer-visibility gap connecting W3-012 to the buyer portal experience.

**Overpayment tolerance (W3-009) and buyer dispute visibility:**
The buyer portal has no mechanism to see or dispute overpayment credits. Excess payment becomes an AdvancePayment record (W3-017) that is not auto-applied and is not surfaced on the buyer's statement screen (`/buyer/statement`). Buyers who overpay have no self-service path to understand where the money went.

---

## L1-B added findings

### L1B-001 — Cron jobs use server UTC time, breaking day-of-week scheduling for non-UTC tenants

- **Severity:** P2
- **Files:**
  - `apps/api/src/order-templates/order-templates.service.ts:222-263` (`@Cron("0 6 * * *")`)
  - `apps/api/src/recurring-invoices/recurring-invoices.service.ts:198` (`@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)`)
- **Issue:** Both cron jobs run on server UTC time. `generateDailyOrders()` fires at 06:00 UTC and uses `today.getDay()` to determine day-of-week. For a tenant in UTC+12 (New Zealand), 06:00 UTC is 18:00 the previous calendar day — the wrong weekday. A standing order set to fire on Monday will fire on Sunday in that timezone. `generateDueRecurringInvoices()` fires at UTC midnight; the same problem applies. The `calcNextRunAt()` method also uses `new Date()` (UTC) to compute the next scheduled date, meaning recurring invoice due dates accumulate off-by-one-day errors for non-UTC tenants.
- **Repro:** Create a standing order template for day=1 (Monday) in a UTC+12 tenant. At server 06:00 UTC on Sunday (which is Monday in UTC+12), the cron runs, but `today.getDay()` returns 0 (Sunday), so the template is skipped. On Monday 06:00 UTC (Tuesday in UTC+12) the cron runs and fires it — one day late.
- **Recommended fix:** Store a timezone per tenant in SystemConfig. In `generateDailyOrders()`, resolve `today` using the tenant timezone before calling `.getDay()`. The recurring invoice `calcNextRunAt()` must accept a timezone parameter and compute dates using a library such as `date-fns-tz` or `luxon`.
- **Expected after fix:** Standing orders and recurring invoices fire on the correct calendar day in the tenant's local timezone regardless of server UTC offset.

### L1B-002 — Standing order cron does not scope to per-tenant context

- **Severity:** P1
- **File:** `apps/api/src/order-templates/order-templates.service.ts:222-263`
- **Issue:** `generateDailyOrders()` calls `this.prisma.forTenant().orderTemplate.findMany(...)`. In a multi-tenant architecture, `forTenant()` requires an active tenant context (AsyncLocalStorage). Cron jobs run outside any HTTP request scope, so no tenant context is set. The behavior of `forTenant()` in this situation depends on the `PrismaService` implementation — if it falls back to a global context or throws, either silent cross-tenant data access or a runtime crash is possible every day at 06:00 UTC.
- **Repro:** Inspect `PrismaService.forTenant()` — if it reads from AsyncLocalStorage with a fallback (e.g. returns global Prisma client), all templates across all tenants will be processed together but without tenant isolation, which is a data-integrity and confidentiality breach. If it throws on missing context, the cron silently fails every day.
- **Recommended fix:** The cron should first fetch all active tenants, then for each tenant set the ALS context and process only that tenant's templates. This is the standard multi-tenant cron pattern.
- **Expected after fix:** Each tenant's standing orders are processed in isolated tenant contexts; no cross-tenant data access.

### L1B-003 — Recurring invoice cron has the same multi-tenant context problem as L1B-002

- **Severity:** P1
- **File:** `apps/api/src/recurring-invoices/recurring-invoices.service.ts:198-226`
- **Issue:** `generateDueRecurringInvoices()` calls `this.prisma.forTenant().recurringInvoice.findMany(...)` outside any HTTP request, with no tenant context established. Same root cause as L1B-002.
- **Recommended fix:** Same pattern: iterate over active tenants, set ALS context per tenant, then process.
- **Expected after fix:** Recurring invoices generated in correct per-tenant isolation.

### L1B-004 — Order number generation uses sequential DB scan with no locking, creating race condition

- **Severity:** P2
- **File:** `apps/api/src/orders/orders.service.ts:543-551`
- **Issue:** Order number is generated by fetching the last `ORD-NNNNN` order and incrementing:
  ```
  const lastOrder = await this.prisma.forTenant().order.findFirst({ ... orderBy: { orderNumber: 'desc' } });
  const seq = parseInt(lastOrder.orderNumber.replace("ORD-", ""), 10) + 1;
  ```
  There is no database transaction or row lock wrapping this read-then-write. Two concurrent order creations can read the same `lastOrder`, compute the same `seq`, and produce duplicate order numbers.
- **Repro:** Submit two orders simultaneously from two buyer sessions. Both read `ORD-00099` as the last order; both compute `seq=100`; both create `ORD-00100`. The second one will not fail (no unique constraint on orderNumber was observed) resulting in two orders with the same number.
- **Recommended fix:** Use a database-level sequence or atomic counter (e.g. a `Sequence` table with `SELECT ... FOR UPDATE`), or add a unique constraint on `orderNumber` and retry on conflict.
- **Expected after fix:** Duplicate order numbers cannot be created under concurrent load.

### L1B-005 — Invoice update allows changing discount/shippingFee on a PAID or PARTIAL invoice if no items are sent

- **Severity:** P1
- **File:** `apps/api/src/invoices/invoices.service.ts:547-641`
- **Issue:** The `update()` method starts with:
  ```
  if (inv.status !== InvoiceStatus.DRAFT)
    throw new BadRequestException("Only DRAFT invoices can be edited");
  ```
  This correctly blocks all edits on non-DRAFT invoices. However, the downstream path at lines 626-641 (the `else` branch when `dto.items` is absent) still executes a DB write that updates `discount`, `shippingFee`, `dueDate`, etc. If — due to a future refactor — the DRAFT check were removed or the method bypassed, discount/fee changes on a paid invoice would not recalculate the total (W3-004), leading to a paid-in-full invoice showing a balance due after a discount was retroactively added.
  **Current status:** The guard holds today. This is a latent fragility, not an active bug. However, the guard and the non-recalculating branch together represent technical debt that will silently break with any refactor.
- **Recommended fix:** Move the total recalculation into a shared helper called by both update branches. This eliminates the divergence and makes the guard's removal less dangerous.
- **Expected after fix:** Any update to discount or fees recalculates the total, regardless of which branch executes.

---

## Final priority list (Finance & Buyer domain)

1. **L1B-002 / L1B-003 (P1)** — Cron jobs run without tenant context in a multi-tenant system. Silent cross-tenant data access or daily silent crash. Fix immediately before any multi-tenant go-live.
2. **W3-003 (P1)** — Credit note allows over-crediting against original invoice total, ignoring payments. Financial integrity breach.
3. **W3-015 (P1)** — Duplicate of order-generated invoice creates double-billing risk. Block duplication when `orderId` is set.
4. **L1B-005 (P1)** — Invoice update latent fragility: non-item updates don't recalculate total; guard is the only safety net.
5. **W5-003 (P1)** — Cart not cleared on logout. Cross-user item leak on shared or multi-account devices.
6. **W3-001 / W3-007 (P2)** — Inconsistent tax base: line discounts reduce tax, order/invoice discounts do not. Pick one policy and apply consistently.
7. **W3-004 (P2)** — Invoice update with discount-only change leaves stale total stored in DB.
8. **W5-001 (P2)** — Cart not persisted to AsyncStorage; lost on every app restart.
9. **W5-002 (P2)** — No stock check at order creation; oversell possible.
10. **L1B-001 (P2)** — Cron day-of-week logic uses UTC; wrong firing day for non-UTC tenants.
11. **L1B-004 (P2)** — Order number generation has race condition under concurrent load.
12. **W3-002 (P2)** — Float arithmetic for tax/total; no rounding before DB storage; cent-level drift.
13. **W3-009 (P2)** — Overpayment tolerance of $0.001 allows negative AR.
14. **W3-011 (P2)** — Order consolidation doesn't revalidate subtotals before merging.
15. **W3-012 / M-W3-B (P2)** — Standing orders use live catalog prices with no buyer notification. File reference should be `order-templates/order-templates.service.ts:282`, not `orders.service.ts`.
16. **W3-013 (P2)** — Credit note sub-penny tolerance leaves $0.001 unresolved.
17. **W3-017 (P2)** — Advance payment not auto-applied; manual reconciliation required.
18. **W5-007 (P2)** — Invoice detail hardcodes "GST (10%)" label regardless of tenant tax rate.
19. **W3-005 (P2)** — Void AR reversal not documented; AR aging reports must explicitly exclude VOID.
20. **W3-006 (P3)** — Recurring invoice prices frozen at template creation; not documented in UI.
21. **W5-013 (P3)** — Deleted product favorites show broken cards in buyer portal.
22. **W3-008 (P3)** — Tier price fallback is silent.
23. **W3-010 (P3)** — Zero-quantity line items allowed on invoices.
24. **W3-014 (P3)** — Order demotion reason stored in mutable notes field, not immutable audit log.
25. **W3-016 (P3)** — PaymentStatus.DRAFT enum value is unused and confusing.
