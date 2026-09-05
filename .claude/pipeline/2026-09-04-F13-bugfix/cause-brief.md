# Cause brief — F13 (B09, B46, B48, B92, B106) recurring invoices / standing orders

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every
> claim carries a file:line, a command output, or a quoted source. Suspected causes are recorded
> AS CLAIMS. No fix proposals. PRE = `d0769701` (master before the F13 build). POST = `9e5ce526`
> (branch `fix/F13-recurring-standing-v2`, confirmed via `git rev-parse
origin/fix/F13-recurring-standing-v2` = `9e5ce526cca75dc4410e1c542cdf76b67b0739f7`).

---

## B46 — MONTHLY recurring invoices re-fire every midnight

### The bug as stated (register/fix-card, verbatim)

- **Meant to do:** A MONTHLY template generates one invoice per cycle: after it fires, `nextRunAt`
  advances to next month's `dayOfMonth` so the midnight cron leaves it alone until then.
- **Actually does:** `calcNextRunAt`'s MONTHLY branch calls `d.setDate(1)` before testing
  `d.getDate() > dom`, so that test always compares `1` against `dom` and is always false — the
  month-advance is dead code and the function returns a date in the SAME month, at or before the
  day it just ran on.
- **The gap:** `nextRunAt` never moves strictly past `now`, so the cron's `nextRunAt <= now` filter
  re-selects the same template every midnight; with `autoSend` on, the customer is emailed a fresh
  invoice daily, indefinitely.
- **Suggested fix (register, unverified claim):** "Decide the month rollover from the pre-`setDate(1)`
  date (compare the candidate against `from`), advance a month whenever the candidate isn't
  strictly in the future, then clamp to `min(dom, daysInThatMonth)`. Assert the returned Date value
  across two consecutive cycles in the spec."

### Repro on PRE — input X gives Y, should give Z

PRE `apps/api/src/recurring-invoices/recurring-invoices.service.ts:20-39`:

```ts
private calcNextRunAt(
  frequency: RecurringFrequency,
  dayOfWeek?: number | null,
  dayOfMonth?: number | null,
  from: Date = new Date(),
): Date {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1); // always at least tomorrow

  if (frequency === RecurringFrequency.MONTHLY) {
    const dom = dayOfMonth ?? 1;
    d.setDate(1);
    d.setMonth(d.getMonth()); // reset to start of month
    // Find next occurrence of dayOfMonth
    if (d.getDate() > dom) d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(dom, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return d;
  }
  ...
```

Traced (register's own trace, reproduced against the quoted lines): `nextRunAt = 2026-07-15`,
`dom = 15` → `d = 2026-07-16` (tomorrow) → `d.setDate(1)` → `d = 2026-07-01` → test
`d.getDate() > dom` is `1 > 15` → **false** → month never advances → `d.setDate(min(15, 31))` →
returns **`2026-07-15`** (input date, unchanged). Expected: a date strictly after `2026-07-15`
(the next MONTHLY occurrence, `2026-08-15`). Wrong value: `calcNextRunAt("MONTHLY", null, 15, new
Date(2026,6,15))` returns `2026-07-15`, not `>= 2026-07-16`.

Downstream: this value is the sole cycle guard. PRE `recurring-invoices.service.ts:174-178`:

```ts
const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, ri.nextRunAt);
const claimed = await this.prisma.forTenant().recurringInvoice.updateMany({
  where: { id: ri.id, nextRunAt: ri.nextRunAt },
  data: { nextRunAt, lastRunAt: new Date() },
});
```

and the cron's selection filter, PRE `:227-236`, uses `nextRunAt: { lte: new Date() }` — a
`nextRunAt` that equals (or precedes) `now` is re-selected the next midnight. PRE
`dto/create-recurring-invoice.dto.ts:31` caps `dayOfMonth` to 1–28, so "tomorrow" almost always
lands in the same month — this is the default outcome, not an edge case (register's framing).

### Suspected cause (claim, unverified)

Register: "calcNextRunAt's MONTHLY branch has dead month-advance code" — `d.setDate(1)` executes
before the `d.getDate() > dom` comparison, making that comparison always `1 > dom` (false).

### Fix as implemented at POST

`recurring-invoices.service.ts:34-59` (`git diff PRE POST`, trimmed):

```ts
if (frequency === RecurringFrequency.MONTHLY) {
  // REG-B46: the old branch called d.setDate(1) BEFORE testing d.getDate() > dom, so
  // the test was always `1 > dom` (false) and the month never advanced ...
  // Clamp first: `dayOfMonth` is a nullable Int with no DB constraint and the PATCH was
  // unvalidated until REG-B92, so a stored 0 or negative is reachable — and it would
  // make the loop below never advance ... hanging the event loop and with it the cron
  // and the whole API process. A corrupt row degrades to day 1, never to a hang.
  const dom = Math.min(31, Math.max(1, Math.trunc(Number(dayOfMonth)) || 1));
  const base = new Date(from);
  base.setHours(0, 0, 0, 0);
  const occurrence = (year: number, monthIndex: number): Date => {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    return new Date(year, monthIndex, Math.min(dom, lastDay));
  };
  let next = occurrence(base.getFullYear(), base.getMonth());
  while (next.getTime() <= base.getTime()) {
    next = occurrence(next.getFullYear(), next.getMonth() + 1);
  }
  return next;
}

const d = new Date(from);
d.setHours(0, 0, 0, 0);
d.setDate(d.getDate() + 1); // always at least tomorrow

// WEEKLY or BIWEEKLY — find next occurrence of dayOfWeek   ← UNCHANGED from here down
```

The unconditional `+1 day` moved below the MONTHLY early-return, so the MONTHLY branch is decided
from `from` directly rather than from an already-advanced `d`.

A second change to this function's call site (POST `:207-215`): the cycle is now advanced from
`max(ri.nextRunAt, now)` rather than `ri.nextRunAt` alone —

```ts
const now = new Date();
const dueAt = ri.nextRunAt ? new Date(ri.nextRunAt) : now;
const advanceFrom = dueAt.getTime() > now.getTime() ? dueAt : now;
const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, advanceFrom);
```

with the comment reasoning that a MONTHLY row frozen for months by the live B46 bug would
otherwise re-select every night during the backlog catch-up window; the fix's own claim is that
missed cycles are "deliberately NOT billed retroactively: this run is the single make-up invoice."

Location at POST: `apps/api/src/recurring-invoices/recurring-invoices.service.ts:34-59` (branch),
`:207-215` (`advanceFrom` call-site change).

### History

`git blame PRE -- apps/api/src/recurring-invoices/recurring-invoices.service.ts` (lines 20-48):

```
79e761745 (Najath Akram 2026-03-29 14:05:44 -0500)  const d = new Date(from); ... (body, incl. buggy branch)
dfdb4419d (Najath Akram 2026-03-30 12:12:40 -0500)  private calcNextRunAt(... signature)
```

The buggy branch (`79e761745`, 2026-03-29) predates and is untouched by the later B9/#373
crash-window fix at `:169-198` (`1fd21f128`, 2026-08-20 — see B106 below), confirming the
register's verifier note ("git blame shows this branch unchanged since [original authorship];
distinct from the Aug-2026 crash-window fix").

### Existing tests around this behavior (PRE)

Register: `recurring-invoices.service.spec.ts:184` asserts only `toBeInstanceOf(Date)`, never the
value — confirmed by the spec diff context (POST diff shows the surrounding describe blocks were
extended, not the pre-existing assertion rewritten in place).

### Tests at POST carrying the REG-B46 token

`apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts` (new file):

- `:62` — `"REG-B46 T1 — the next occurrence of dayOfMonth is the earliest one strictly after
\`from\`"`— asserts`calcNextRunAt("MONTHLY", null, 15, new Date(2026,6,15))`returns`2026-08-15` (year/month/date), i.e. strictly past the PRE code's wrong same-day return.
- `:76` — `"REG-B46 T1b — a corrupt dayOfMonth (0 or negative) is clamped, never looped on"` —
  asserts `dayOfMonth: 0` and `-3` both clamp to day 1 of the next month rather than looping.
- `:89` — `"REG-B46 T3 — December rolls into January of the next year"` — asserts year rollover.
- `:96` — `"REG-B46 T5 — a time-of-day on \`from\` is treated as its calendar day"`.
- `:104` — `"REG-B46 T6 — twelve consecutive cycles each strictly advance and land on the 15th
(Feb 2026 .. Jan 2027)"` — asserts, per cycle, `next.getTime() > current.getTime()` across 12
  chained calls.
- `:135` (describe `"cycle claim carries the corrected nextRunAt (R4, B46)"`) — `:139` `"REG-B46
T7 — generateInvoiceFromTemplate claims the cycle with the strictly-future nextRunAt"` — asserts
  the value passed to `recurringInvoice.updateMany`'s `data.nextRunAt` is `> Date.now()` at call
  time and lands on the template's `dayOfMonth`.
- `:153` — `"REG-B46 T7b — a months-overdue template is claimed into the future, not one month
on"` — asserts an 8-months-stale `nextRunAt` still claims strictly into the future.

`recurring-invoices.service.spec.ts` (existing file, extended at POST) — pins with no token:
`"dayOfMonth 15, from 2026-07-10 ... -> 2026-07-15"` (T4), `"pin (T2, R2): dayOfMonth 31 clamps
2026-01-31 -> Feb 28 -> Mar 31"` (T2), plus a WEEKLY/BIWEEKLY-unchanged describe (T8) and a
cron-continues-past-a-failing-template pin (T21, `"attempts the second due template after the
first one throws"`, asserting `invoices.create` called twice for two due templates when the first
throws).

### The v1 run's own claims (RESUME.md / build-plan.md)

- `build-plan.md` close-out table: "MONTHLY branch of `calcNextRunAt` rewritten (from-anchored,
  clamped, `while (next <= base)`) | `recurring-invoices.service.ts:34-59` | B46 | Order 2 /
  R1,R2 | WEEKLY/BIWEEKLY block moved below the MONTHLY early-return but byte-identical."
- v1's own verify-narrative (`f13-v1-evaluation.md:129-136`): "**B46 — implemented & proven.**
  ... `Math.min(dom, daysInMonth)`-clamped `while (next <= base)` loop. Five REG-B46 tests"; notes
  two cases ("`REG-B46 dom 31 chain` and `from earlier in the month`") were demoted to untokened
  pins in the existing spec file rather than kept as red-set B46 proofs — matching what is found
  at POST (T2/T4 above carry no REG token).
- RESUME.md ledger-flip intent: "B46, B48, B106 → `proven` (T1, naming REG tests + probes)."

---

## B48 — Standing-order reorder bills raw list price

### The bug as stated (register/fix-card, verbatim)

- **Meant to do:** An order generated from a standing-order template (buyer "Reorder Now" or the
  daily 6am cron) should bill each line at the price the buyer would get shopping manually: their
  pricing tier, any `CustomerPrice` override, any active promotion.
- **Actually does:** `createOrderFromTemplate` prices every line at raw `product.pricePerUnit` and
  calls `computeLineSubtotal` with it — no tier lookup, no `CustomerPrice`, no promotion
  resolution anywhere in the function.
- **The gap:** Every template-generated order bills full list price, silently overcharging any
  customer with a discounted tier, a negotiated override, or an active promotion on a templated
  product.

### Repro on PRE — input X gives Y, should give Z

PRE `apps/api/src/order-templates/order-templates.service.ts:322-370` (trimmed to the pricing
lines):

```ts
const tenantId = this.prisma.getTenantId();
let subtotal = 0;
const lineItemsData = allowedItems.map((item) => {
  const product = productMap.get(item.productId);
  if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
  const unitPrice = Number(product.pricePerUnit);
  // A template qty is a SELLING-UNIT count (a box for boxed products), so the
  // line subtotal is unitPrice × qty ...
  const itemSubtotal = computeLineSubtotal({ unitPrice, qty: item.qty });
  subtotal = roundMoney(subtotal + itemSubtotal);
  return {
    productId: item.productId,
    qty: item.qty,
    unitPrice,
    subtotal: itemSubtotal,
    ...
```

Input: a customer at pricing tier 2 (with a lower `priceTier2` on the product, or an active
`CustomerPrice` override, or an active CUSTOMER promotion) reorders a standing-order template
containing that product. `unitPrice` is read only from `product.pricePerUnit` (list price) —
`tierForProduct`, `CustomerPrice`, and promotion resolution are never consulted anywhere in this
function (confirmed: no `customerPrice`, no `pricingTier`, no `loadActivePromotions` call exists
in the PRE version of this method). Observed: the generated order line bills at
`product.pricePerUnit` regardless of tier/override/promo. Expected: the line should bill at
whatever `resolveBuyerLinePrice` would compute for that customer/tier/promo combination (the same
value the buyer's own interactive checkout produces for the identical line) — a strictly lower or
equal amount whenever a discount, override, or promo applies. Register: reachable from
`apps/api/src/buyer/buyer.controller.ts:742-757` (POST reorder) and the `@Cron('0 6 * * *')`
`generateDailyOrders`.

### Suspected cause (claim, unverified)

Register: `createOrderFromTemplate` never resolves price through the tier/override/promo pipeline
that "everywhere else" uses (`buyer-catalog.service.ts:193-207`, `orders.service.ts:119-174,
1742-1753` — `resolveBuyerLinePrice`).

### Fix as implemented at POST

`order-templates.service.ts` (`git diff PRE POST`, trimmed):

```ts
// REG-B48: a standing order is the CUSTOMER's order whoever triggers it (06:00 cron,
// operator "Generate now", buyer "Reorder"), so every line is priced exactly as the
// buyer's own checkout in orders.service.create ...
const customerRecord = await this.prisma.forTenant().customer.findUnique({
  where: { id: template.customerId },
  select: { pricingTier: true },
});
const defaultTier = customerRecord?.pricingTier ?? 1;
const customerPrices = await this.prisma.forTenant().customerPrice.findMany({
  where: { customerId: template.customerId, productId: { in: productIds } },
});
const cpTier = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));
const activePromos = await this.ordersService.loadActivePromotions(UserRole.CUSTOMER);
const priceHistory = await this.ordersService.getCustomerPriceHistory(template.customerId);

const tenantId = this.prisma.getTenantId();
let subtotal = 0;
const lineItemsData = allowedItems.map((item) => {
  const product = productMap.get(item.productId);
  if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
  const tierForProduct = cpTier.get(item.productId) ?? defaultTier;
  const upb = Number(product.unitsPerBox ?? 0);
  const qtyUnits = item.qty;
  const qtyPieces = upb > 1 ? item.qty * upb : item.qty;
  const resolved = this.ordersService.resolveBuyerLinePrice(
    product, tierForProduct, activePromos, qtyPieces, qtyUnits,
    priceHistory[item.productId]?.lastPrice ?? null,
    { boxes: null, pieces: null, unitsPerBox: upb },
  );
  const itemSubtotal = computeLineSubtotal({
    unitPrice: resolved.unitPrice, qty: item.qty, freeUnits: resolved.freeUnits,
  });
  subtotal = roundMoney(subtotal + itemSubtotal);
  return {
    productId: item.productId, qty: item.qty,
    unitPrice: resolved.unitPrice, priceType: resolved.priceType,
    originalPrice: resolved.originalPrice,
    promoFreeUnits: resolved.freeUnits > 0 ? resolved.freeUnits : null,
    subtotal: itemSubtotal, ...
```

This required widening two `OrdersService` methods from `private` to method-visible, at
`apps/api/src/orders/orders.service.ts:115` (`loadActivePromotions`) and `:137`
(`resolveBuyerLinePrice`) — `git diff`:

```diff
-  private async loadActivePromotions(role: UserRole): Promise<PromotionRule[]> {
+  async loadActivePromotions(role: UserRole): Promise<PromotionRule[]> {
...
-  private resolveBuyerLinePrice(
+  resolveBuyerLinePrice(
```

Location at POST: `apps/api/src/order-templates/order-templates.service.ts:372-450` (pricing
block); `apps/api/src/orders/orders.service.ts:115,137` (visibility widening).

### History

`git blame PRE -- apps/api/src/order-templates/order-templates.service.ts` (lines 320-335):

```
bb3b3446c (Najath Akram 2026-03-11 21:48:22 -0500)  name: string; ... productIds = template.items.map ...
17b122c70 (najathakram  2026-07-08 13:12:43 +0530)  // W6: regulated license guard ...
```

The pricing lines (`unitPrice = Number(product.pricePerUnit)` etc., PRE `:322-335`, not separately
blamed above but contiguous with `bb3b3446c`) trace to the same original authorship
(`bb3b3446c`, 2026-03-11) as the surrounding function signature; the regulated-license guard was
added later (`17b122c70`, 2026-07-08) without touching the pricing lines.

### Existing tests around this behavior (PRE)

None in scope named in the register beyond the contrast citations (`buyer-catalog.service.ts`,
`orders.service.ts`) — no PRE spec on `order-templates.service.ts` asserted tier/override/promo
pricing for `createOrderFromTemplate` (confirmed: `order-templates.pricing-and-items.spec.ts` is a
new file at POST, per `git diff --stat PRE POST`).

### Tests at POST carrying the REG-B48 token

`apps/api/src/order-templates/order-templates.pricing-and-items.spec.ts` (new file):

- `:90` — `"REG-B48 prices a template line via the tier ladder (tier 2 -> priceTier2) and
computes the subtotal (T9)"`.
- `:119` — `"REG-B48 a per-product CustomerPrice override beats the customer's default tier
(T10)"`.
- `:145` — `"REG-B48 a null CustomerPrice override falls through to the customer's default tier
(T11)"`.
- `:165` — `"REG-B48 applies the best active promotion, loaded for the CUSTOMER role (T12)"`.
- `:194` — `"REG-B48 a BUY_N_GET_M promotion reduces the subtotal by whole free units (T13)"`.
- `:215` — `"REG-B48 a boxed product's template qty bills as whole boxes, no proration (T14)"`.
- `:240` — `"REG-B48 a remembered above-list price (sticky upsell) wins over the tier (T15)"`.
- `:259` — `"REG-B48 tier 1 with no override/promo/history still persists STANDARD and a null
originalPrice (T16)"`.

`order-templates.service.spec.ts` (existing file, extended at POST): a `"pin (T16): tier 1, no
override/promo/history -> list price and subtotal unchanged"` test with no token (asserted per
build-plan.md as the pin analogue).

### The v1 run's own claims

- `build-plan.md` close-out: "Template pricing via the shared resolver (tier → CustomerPrice
  override → promo → sticky upsell), persists `priceType`/`originalPrice`/`promoFreeUnits` |
  `order-templates.service.ts:386-450` | B48 | Order 5 / R5-R11 | `categoryTaxAmount: 0` left
  as-is, per plan."
- `f13-v1-evaluation.md:139-146`: "**B48 — implemented & proven, but the change leaves the
  existing suite red.**" — flags that widening `orders.service.ts:115,137` to public and the B48
  change together broke 3 pre-existing "regulated license guard on reorder" tests on a mock gap
  (`loadActivePromotions is not a function`), noted as "FIXED before this run (step 0)" in the
  later remediation plan draft — i.e. the evaluator's own account says this was a real breakage
  window during v1's authoring, subsequently patched.
- RESUME.md ledger-flip intent: B48 → `proven` (T1).

---

## B09 — Standing-order edits silently drop item changes

### The bug as stated (register/fix-card, verbatim)

- **Meant to do:** Editing a standing order should let the operator update days/name/notes and
  also add, remove, or adjust quantities of product line items, since the modal shows a full
  product UI.
- **Actually does:** In edit mode the same interactive product search/add/remove/qty-stepper UI
  renders and updates local state, but `handleSubmit`'s `isEditing` branch only calls
  `updateTemplate.mutate({id,name,daysOfWeek,notes})` — items are never sent.
- **The gap:** Any item add/remove/qty change made while editing is silently discarded on save;
  `useAddTemplateItem`/`useRemoveTemplateItem` exist but are called from zero UI in web or mobile.
- **Rounds 4-5 addition (register, Aug 29 2026):** the API side carries a matching asymmetry —
  `POST /order-templates/:id/items` excludes CUSTOMER while `DELETE /:id/items/:itemId` admits
  them (`order-templates.controller.ts:65-70` vs `:72-81`), unreachable today only because no
  screen calls either hook.

### Repro on PRE — input X gives Y, should give Z

PRE `apps/web/app/(dashboard)/customers/[id]/StandingOrderModal.tsx:178-194`:

```tsx
if (isEditing && template) {
  // Edit: only update template fields (not items in this flow — items managed separately)
  updateTemplate.mutate(
    {
      id: template.id,
      name: name.trim(),
      daysOfWeek: selectedDays,
      notes: notes.trim() || undefined,
    },
    {
      onSuccess: () => {
        toast({ title: "Standing order updated", variant: "success" });
        onClose();
      },
    },
  );
}
```

Input: an operator opens an existing standing-order template's edit modal, uses the same
add/remove/qty-stepper item UI the modal always renders (confirmed unconditional rendering — no
`isEditing` gate around the product-search/line-item section in the PRE JSX), changes a quantity
or adds a product, and clicks Save. Observed: the mutation payload sent to
`PATCH /order-templates/:id` is `{id, name, daysOfWeek, notes}` — `lineItems` (the in-modal state
holding the edited list) is read nowhere in this branch. Expected: the saved template should
reflect the edited item list. Wrong value: template items after save are byte-identical to before
the edit, even though the toast reports "Standing order updated" (silent, successful-looking data
loss).

Corroborating repo-wide fact from the register (cited, not independently re-run here):
`useAddTemplateItem`/`useRemoveTemplateItem` (`apps/web/lib/api/order-templates.ts:92,107`) have
no callers in web or mobile — the PATCH-based route this fix takes was not even attempted by v0.

### Suspected cause (claim, unverified)

Register: `handleSubmit`'s `isEditing` branch omits `items` from the PATCH body even though the
same UI that creates templates (which does send `items`) is shown in edit mode.

### Fix as implemented at POST

`StandingOrderModal.tsx` (`git diff PRE POST`, trimmed):

```tsx
const itemSignature = (items: { productId: string; qty: number; notes?: string }[]) =>
  items
    .map((i) => `${i.productId}:${i.qty}:${i.notes ?? ""}`)
    .sort()
    .join("|");
...
if (isEditing && template) {
  // REG-B09: the modal shows the full item list in edit mode, so it saves the full
  // list — adds, removes and qty changes included (PATCH replaces items). ...
  // `items` is sent ONLY when the list actually differs from the loaded template ...
  const itemsChanged = itemSignature(lineItems) !== itemSignature(template.items);
  updateTemplate.mutate(
    {
      id: template.id,
      name: name.trim(),
      daysOfWeek: selectedDays,
      notes: notes.trim() || undefined,
      ...(itemsChanged
        ? { items: lineItems.map((li) => ({ productId: li.productId, qty: li.qty, notes: li.notes })) }
        : {}),
    },
    { onSuccess: () => { ... } },
  );
```

Backing API changes: `apps/api/src/order-templates/dto/update-order-template.dto.ts` — `items?:
OrderTemplateItemDto[]` added with `@IsOptional @IsArray @ArrayMinSize(1) @ValidateNested
@Type(() => OrderTemplateItemDto)`. `apps/api/src/order-templates/order-templates.service.ts:166-215`
(`update()`, `git diff PRE POST`, trimmed):

```ts
async update(id: string, dto: UpdateOrderTemplateDto) {
  await this.findOne(id);
  ...
  if (!dto.items) {
    return this.prisma.forTenant().orderTemplate.update({ where: { id }, data: scalar, include });
  }
  // REG-B09: an edit that carries `items` REPLACES the template's items ... Every
  // productId must exist in this tenant (mirrors create()) BEFORE any write, and the
  // delete + re-create run in ONE transaction so a failure can never leave a template
  // with no items.
  const items = dto.items;
  const productIds = [...new Set(items.map((i) => i.productId))];
  const products = await this.prisma.forTenant().product.findMany({ where: { id: { in: productIds } }, select: { id: true } });
  if (products.length !== productIds.length) {
    throw new BadRequestException("One or more products not found");
  }
  const tenantId = this.prisma.getTenantId();
  return this.prisma.tenantTransaction(async (tx) => {
    await tx.orderTemplateItem.deleteMany({ where: { templateId: id } });
    return tx.orderTemplate.update({
      where: { id },
      data: { ...scalar, items: { create: items.map((item) => ({ productId: item.productId, qty: item.qty, notes: item.notes, tenantId })) } },
      include,
    });
  });
}
```

`apps/web/lib/api/order-templates.ts:67-77` — `useUpdateOrderTemplate`'s mutation-variables type
widened to include `items?: {productId, qty, notes?}[]`.

### History

`git blame PRE -- StandingOrderModal.tsx` (lines 179-195): entire `handleSubmit` isEditing branch
attributed to `bb3b3446c (Najath Akram, 2026-03-11 21:48:22 -0500)` — original authorship, never
revisited since.

### Existing tests around this behavior (PRE)

None cited in the register for this component; no `.test.tsx` for `StandingOrderModal.tsx` exists
in the diff stat (not among the 38 changed files' test entries).

### Tests at POST carrying the REG-B09 token

- `apps/api/src/order-templates/dto/update-order-template.dto.spec.ts:18` — `"REG-B09 accepts
items on a PATCH and whitelists productId/qty (T23)"` — asserts
  `pipe.transform({name:"x", items:[{productId:"p1",qty:2}]}, meta)` resolves to
  `{name:"x", items:[{productId:"p1",qty:2}]}`. Same file carries untokened pins: rejects an empty
  items array, rejects qty 0, rejects a client-supplied `unitPrice` on a template item, accepts a
  body with no `items` key.
- `apps/api/src/order-templates/order-templates.pricing-and-items.spec.ts:273` — `"REG-B09
update() replaces items atomically in one transaction, deleteMany before the write (T25)"`.
- `:313` — `"REG-B09 update() validates every item's product exists before writing anything
(T26)"`.
- `apps/web/e2e/30-recurring-standing.spec.ts:90` — `"REG-B09 the Edit Standing Order modal
persists item adds and qty changes through the templates PATCH (R22 / T28)"` (T2, web-visible,
  proven-pending-deploy per the card; not run locally per policy).

Note: the abandoned remediation plan's evaluation (`f13-v1-evaluation.md:148-151,184-186`) records
that at an EARLIER point in the v1 run these two `order-templates.pricing-and-items.spec.ts`
proofs (T25/T26) and the dto spec's T23 were tokened `REG-B48` instead of `REG-B09` ("mis-tokened
... B09 has zero REG-B09 jest titles"). At POST (`9e5ce526`, current state per the grep above)
they carry the correct `REG-B09` token — i.e. the retokening the abandoned plan proposed as
"Finding #3 / step 0" is already reflected in the snapshotted tree.

### The v1 run's own claims

- `build-plan.md` close-out: "`UpdateOrderTemplateDto` items field ... B09 | Order 6 / R20";
  "`OrderTemplatesService.update()`: product-existence check → `tenantTransaction` ... B09 |
  Order 6 / R21 | Controller untouched (F14 lane respected)"; "Modal `LineItem.notes` seeded +
  edit branch sends `items` | `StandingOrderModal.tsx:33,103,182-191` | B09 | Order 7 | Modal
  already blocks a 0-item save (`:175`), consistent with `ArrayMinSize(1)`."
- `f13-v1-evaluation.md:148-151`: "**B09 — implemented, unproven.** Jest T23/T25/T26 pass but
  carry the wrong token (REG-B48), so a REG-B09 grep over jest finds zero results" — this
  evaluation predates the retokening now visible at POST.
- RESUME.md ledger-flip intent: B09 → `proven-pending-deploy` (T2, spec 30 e2e).

---

## B92 — Recurring invoice templates cannot be edited after creation

### The bug as stated (register/fix-card, verbatim)

- **Meant to do:** After creating a recurring template, an operator can open it to fix a typo,
  change a line price, or move its schedule from weekly to monthly — without deleting and
  rebuilding it.
- **Actually does:** The list page renders only Run Now and Pause/Activate per card; only the list
  and `new` routes exist, with no `[id]` route. The typed `useRecurringInvoice` /
  `useUpdateRecurringInvoice` hooks and a working `PATCH /recurring-invoices/:id` (real service
  update, item replacement included) exist and are never called from any component.
- **The gap:** A fully working backend PATCH and fully typed frontend hooks with no UI reaching
  them.

### Repro on PRE — input X gives Y, should give Z

PRE `apps/web/app/(dashboard)/invoices/recurring/page.tsx` directory contains only `page.tsx` and
`new/page.tsx` (register-cited; confirmed absent in the diff stat's PRE side — the `[id]/edit/`
path is entirely new at POST). Input: an operator wants to fix a typo or reschedule an existing
recurring template. Observed: no UI control anywhere in the app reaches `PATCH
/recurring-invoices/:id` — only "Run Now" and Pause/Activate exist per card
(`page.tsx:163-167` region, register-cited). Expected: an edit affordance reaching the working
PATCH. Additionally, the PATCH handler itself was unvalidated: PRE
`recurring-invoices.controller.ts:41` —

```ts
@Patch(":id")
update(@Param("id") id: string, @Body() dto: Partial<CreateRecurringInvoiceDto>) {
  return this.recurringInvoicesService.update(id, dto);
}
```

`Partial<CreateRecurringInvoiceDto>` is a TypeScript mapped type that erases to `Object` in
`design:paramtypes`, which the global `ValidationPipe` skips — so even if a UI existed, the PATCH
body was never validated or whitelisted (confirmed by the new dto spec's own comment, see below).

### Suspected cause (claim, unverified)

Register: purely a missing frontend affordance — backend PATCH exists and works
(`recurring-invoices.service.ts:103-123` in the PRE line numbering the register cites,
frequency/schedule/notes/terms/discount/shippingFee/items all patchable), but no route/link calls
it.

### Fix as implemented at POST

New route `apps/web/app/(dashboard)/invoices/recurring/[id]/edit/page.tsx` (full file quoted
above under "web recurring/[id]/edit/page.tsx"), consuming `useRecurringInvoice` /
`useUpdateRecurringInvoice` and a new shared `RecurringInvoiceForm` component
(`apps/web/app/(dashboard)/invoices/recurring/_components/RecurringInvoiceForm.tsx`, new file,
556 lines per `git diff --stat`). List page link added,
`apps/web/app/(dashboard)/invoices/recurring/page.tsx` (`git diff PRE POST`, trimmed):

```tsx
<Button
  size="sm"
  variant="secondary"
  leftIcon={<Pencil className="h-3.5 w-3.5" />}
  href={`/invoices/recurring/${ri.id}/edit`}
>
  Edit
</Button>
```

Validated DTO added, `apps/api/src/recurring-invoices/dto/update-recurring-invoice.dto.ts` (new
file, full content):

```ts
import { PartialType } from "@nestjs/mapped-types";
import { CreateRecurringInvoiceDto } from "./create-recurring-invoice.dto";

/**
 * REG-B92: the PATCH /recurring-invoices/:id body. Before this class the handler was
 * typed `Partial<CreateRecurringInvoiceDto>` — a mapped type erases to `Object` in
 * design:paramtypes, which the global ValidationPipe skips entirely, so the PATCH body
 * was never validated or whitelisted. ... Deliberately no `isActive`: pause/resume are
 * DELETE /:id and POST /:id/activate.
 */
export class UpdateRecurringInvoiceDto extends PartialType(CreateRecurringInvoiceDto) {}
```

Controller updated, `recurring-invoices.controller.ts` (`git diff`):

```diff
-  update(@Param("id") id: string, @Body() dto: Partial<CreateRecurringInvoiceDto>) {
+  update(@Param("id") id: string, @Body() dto: UpdateRecurringInvoiceDto) {
```

Service `update()` rewritten to wrap item replacement in one `tenantTransaction` (POST
`recurring-invoices.service.ts:133-172`, `git diff PRE POST`, trimmed):

```ts
async update(id: string, dto: UpdateRecurringInvoiceDto) {
  await this.findOne(id);
  const include = { customer: {...}, items: true };
  const data = { ...scalars };
  if (!dto.items) {
    return this.prisma.forTenant().recurringInvoice.update({ where: { id }, data, include });
  }
  // REG-B92: replace the lines in ONE transaction — a failure between the delete and
  // the re-create must never leave a template with no items.
  const tenantId = this.prisma.getTenantId();
  const items = dto.items;
  return this.prisma.tenantTransaction(async (tx) => {
    await tx.recurringInvoiceItem.deleteMany({ where: { recurringInvoiceId: id } });
    return tx.recurringInvoice.update({
      where: { id },
      data: { ...data, items: { create: items.map((i) => ({ ..., tenantId })) } },
      include,
    });
  });
}
```

Location at POST: `apps/api/src/recurring-invoices/dto/update-recurring-invoice.dto.ts` (new);
`recurring-invoices.controller.ts:18,42`; `recurring-invoices.service.ts:133-172`;
`apps/web/app/(dashboard)/invoices/recurring/[id]/edit/page.tsx` (new);
`.../_components/RecurringInvoiceForm.tsx` (new); `.../page.tsx` edit-link addition.

### History

`git blame` was not run on this file's original authorship beyond what the diff stat shows (no
PRE `[id]` route exists to blame — the gap is an absence, not a defective line). The controller's
`Partial<CreateRecurringInvoiceDto>` typing predates this batch; not separately blamed here (the
register's evidence citation is the mapped-type erasure behavior itself, a documented TS/Nest
interaction, not a single introducing commit).

### Existing tests around this behavior (PRE)

None — register cites the hooks/PATCH as untested-by-omission (dead on the client), and no
`recurring-invoices.controller.spec.ts` PATCH-validation test is cited.

### Tests at POST carrying the REG-B92 token

- `apps/api/src/recurring-invoices/dto/update-recurring-invoice.dto.spec.ts:25` — `"REG-B92 T29 —
a partial body such as { notes } validates against the DTO class"` — asserts
  `pipe.transform({notes:"x"}, meta)` resolves to `{notes:"x"}`. Untokened pins in the same file:
  `"T30 — rejects a non-whitelisted key (isActive)"` (expects 400), `"T30 — rejects an empty items
array"` (expects 400), `"T30 — rejects an item with a non-numeric qty"` (expects 400), `"T30 —
accepts a full create-shaped body"`. File header comment: "Dynamic require + try/catch so this
  file compiles and runs before `UpdateRecurringInvoiceDto` exists: T29 fails on its own
  `toBeDefined()` assertion, not an import/build error."
- `apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts:266` — `"REG-B92
T31 — item replacement runs inside one tenantTransaction with tenantId stamped on nested
creates (T31)"`.
- `apps/web/e2e/30-recurring-standing.spec.ts:201` — `"REG-B92 the recurring-template edit page
persists a schedule and notes change through the validated PATCH (R26, R27 / T32)"` (T2,
  web-visible, proven-pending-deploy).

### The v1 run's own claims

- `build-plan.md` close-out: "`UpdateRecurringInvoiceDto extends PartialType(CreateRecurringInvoiceDto)`
  ... B92 | Order 4 | `@nestjs/mapped-types` resolves"; "`update()` rebuilt: scalars hoisted, item
  replace inside ONE `tenantTransaction`, `tenantId` stamped | ... | B92 | Order 4 / R25 |
  `isActive` deliberately unmapped"; "Form extracted from `new/page.tsx` (530 lines removed) into
  `_components/RecurringInvoiceForm.tsx` (mode create/edit) ... B92 | Order 7 | Customer read-only
  in edit; 'First Run Date' → 'Next Run Date'."
- `f13-v1-evaluation.md:155`: "**B92 — implemented, unproven.**" (context truncated in the grep
  excerpt available to this brief; the evaluator's summary table at `:122` records "REG-B92 |
  ... T29 ... T31 | 2 jest titles | both pass").
- RESUME.md ledger-flip intent: B92 → `proven-pending-deploy` (T2, spec 30).

---

## B106 — Recurring cycle claimed before invoice creation, failure silently skips the bill

### The bug as stated (register/fix-card, verbatim)

- **Meant to do:** Every due recurring template bills its customer once per cycle; a generation
  failure should be visible so someone re-runs it (code comment: "recoverable via runNow").
- **Actually does:** `nextRunAt`/`lastRunAt` are stamped first; if `invoicesService.create` then
  throws, the cron's catch only logs and `totalFail` is never persisted. The UI renders the fresh
  `lastRunAt` as positive confirmation.
- **The gap:** Cycle consumed, no invoice, no error column or status flag on `RecurringInvoice`
  (PRE), no retry — the customer is simply never billed for the period.
- **Verifier's note (register):** claim-first ordering is a deliberate #373 trade-off against
  duplicate invoices; the defect is the unsurfaced failure, not the ordering. Interaction with
  open B46: for MONTHLY templates `calcNextRunAt` doesn't advance past `now`, so the cron
  accidentally retries next midnight; the permanent silent skip fully bites WEEKLY/BIWEEKLY today
  and MONTHLY once B46 is fixed.

### Repro on PRE — input X gives Y, should give Z

PRE `recurring-invoices.service.ts:169-251` (full `generateInvoiceFromTemplate` + cron):

```ts
private async generateInvoiceFromTemplate(ri: any) {
  // Claim the cycle BEFORE creating anything. ...
  const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, ri.nextRunAt);
  const claimed = await this.prisma.forTenant().recurringInvoice.updateMany({
    where: { id: ri.id, nextRunAt: ri.nextRunAt },
    data: { nextRunAt, lastRunAt: new Date() },
  });
  if (claimed.count === 0) { ...; return null; }

  const invoice = await this.invoicesService.create({ ... });   // <-- throws here, uncaught
  ...
}

@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
async generateDueRecurringInvoices() {
  ...
  for (const ri of due) {
    try {
      await this.generateInvoiceFromTemplate(ri);
      totalSuccess++;
    } catch (err) {
      totalFail++;
      this.logger.error(`... Failed to generate invoice ...`);
    }
  }
  ...
}
```

Input: a WEEKLY/BIWEEKLY due `RecurringInvoice` whose customer no longer exists, or whose
`invoicesService.create` throws for any reason (e.g. `ConflictException` on `P2002`, register
cites `invoices.service.ts:527-531`), is processed by the midnight cron. Observed: the claim
`updateMany` already committed `nextRunAt` (advanced) and `lastRunAt: new Date()` BEFORE
`invoicesService.create` is called; when `create` throws, the `catch` block only increments an
in-memory `totalFail` counter and logs — no column is written, no invoice exists, and
`nextRunAt` stays permanently advanced past this cycle (nothing gives it back). The web list page
(register-cited `page.tsx:163-167`) renders the just-written `lastRunAt` as "Last run: <date>" —
a positive-looking timestamp with no failure indicator. Expected: a failed cycle should either
retry or at minimum surface `lastRunStatus`/`lastError` so an operator notices the customer was
never billed. Wrong value/state: after a `create` throw, `RecurringInvoice.nextRunAt` is
permanently past this cycle, `lastRunAt` reads as a normal successful run, and no persisted signal
distinguishes it from a real success.

Note: PRE schema already defines `lastRunStatus String?` / `lastError String?` on
`RecurringInvoice` (`git show d0769701:apps/api/prisma/schema.prisma:2805-2806` — confirmed
present verbatim in both PRE and POST schema dumps), so the columns pre-existed this batch (per
the card's "Requires F01" dependency note) but were never written by `generateInvoiceFromTemplate`
on the failure path at PRE.

### Suspected cause (claim, unverified)

Register: the claim-then-create ordering (itself a deliberate prior fix, #373, against a
duplicate-invoice race) has no compensating write on the `create` failure path — the outcome is
only logged, never persisted, so nothing distinguishes a silently-skipped cycle from a genuine
success in any operator-facing surface.

### Fix as implemented at POST

`recurring-invoices.service.ts` (`git diff PRE POST`, trimmed to the three outcome-recording
edits):

**(1) Claim now stamps a provisional FAILED outcome**, `:201-218`:

```ts
const now = new Date();
const dueAt = ri.nextRunAt ? new Date(ri.nextRunAt) : now;
const advanceFrom = dueAt.getTime() > now.getTime() ? dueAt : now;
const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, advanceFrom);
const claimed = await this.prisma.forTenant().recurringInvoice.updateMany({
  where: { id: ri.id, nextRunAt: ri.nextRunAt },
  data: {
    nextRunAt,
    lastRunAt: new Date(),
    lastRunStatus: RUN_STATUS_FAILED,
    lastError: RUN_INTERRUPTED_ERROR,
  },
});
```

**(2) `create` wrapped in try/catch; on throw, `nextRunAt` is restored (PLAIN `update`, not a
compare-and-set) and the failure is recorded, then rethrown**, `:229-252`:

```ts
let invoice: any;
try {
  invoice = await this.invoicesService.create({ ... });
} catch (err) {
  // REG-B106: record the failure AND give the cycle back. ...
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await this.prisma
    .forTenant()
    .recurringInvoice.update({
      where: { id: ri.id },
      data: { nextRunAt: ri.nextRunAt, lastRunStatus: RUN_STATUS_FAILED, lastError: message },
    })
    .catch((e: any) => this.logger.error(`... could not be recorded (${e?.message ?? e})`));
  throw err;
}
```

**(3) SUCCESS written only after the invoice is created AND linked; a post-create finalize
failure is recorded as billed-but-unfinalized, `nextRunAt` NOT restored**, `:265-289`:

```ts
try {
  await this.prisma
    .forTenant()
    .invoice.update({ where: { id: invoice.id }, data: { recurringInvoiceId: ri.id } });
  // REG-B106: only now — invoice created and linked — is the cycle a success. Never
  // carries nextRunAt (the claim above is the single schedule write on this path).
  await this.prisma.forTenant().recurringInvoice.update({
    where: { id: ri.id },
    data: { lastRunStatus: RUN_STATUS_SUCCESS, lastError: null },
  });
} catch (err) {
  // REG-B106: the invoice EXISTS here ... Never restore nextRunAt: this cycle IS billed ...
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  this.logger.error(
    `... invoice ${invoice.id} was created but the run could not be finalized (${message})`,
  );
  await this.prisma
    .forTenant()
    .recurringInvoice.update({
      where: { id: ri.id },
      data: {
        lastRunStatus: RUN_STATUS_FAILED,
        lastError: `${RUN_UNFINALIZED_ERROR} (invoice ${invoice.id}): ${message}`.slice(0, 500),
      },
    })
    .catch((e: any) =>
      this.logger.error(`... unfinalized outcome could not be recorded (${e?.message ?? e})`),
    );
}
```

Status constants exported near the top of the file, `:9-16`:

```ts
export const RUN_STATUS_SUCCESS = "SUCCESS";
export const RUN_STATUS_FAILED = "FAILED";
export const RUN_INTERRUPTED_ERROR = "Generation was interrupted before the invoice was created";
export const RUN_UNFINALIZED_ERROR = "The invoice was created but the run could not be finalized";
```

Web surfacing: `apps/web/lib/api/invoices.ts` — `RecurringInvoice.lastRunStatus`/`lastError`
fields added; `RUN_UNFINALIZED_PREFIX` constant and `isRetryableRunFailure()` helper added
(`git diff`, quoted above). `apps/web/app/(dashboard)/invoices/recurring/page.tsx` — Succeeded/
Failed pill and a truncated `lastError` line with a conditional "use Run Now to retry" hint
(`git diff`, quoted above). Mobile mirror: `apps/mobile/lib/recurring-invoices-logic.ts` —
`lastRunOutcome()` helper (full file quoted above under "mobile recurring-invoices-logic.ts").

Location at POST: `apps/api/src/recurring-invoices/recurring-invoices.service.ts:9-16` (constants),
`:201-218` (claim), `:229-252` (create try/catch + rollback), `:265-289` (link + SUCCESS/finalize
try/catch); `apps/web/lib/api/invoices.ts:769-786`; `apps/web/app/(dashboard)/invoices/
recurring/page.tsx:166-207`; `apps/mobile/lib/recurring-invoices-logic.ts:51-75`.

### History

`git blame PRE -- recurring-invoices.service.ts` (lines 169-199): claim-first block
(`:170-183`) attributed to `1fd21f128 (najathakram, 2026-08-20 01:41:18 -0500)` — the #373
crash-window fix the register's verifier note references; the `invoicesService.create` call and
everything through the return (`:184-199`) attributed to the original `79e761745 (Najath Akram,
2026-03-29 14:05:44 -0500)` authorship, unchanged by `1fd21f128`.

### Existing tests around this behavior (PRE)

`recurring-invoices.service.spec.ts` — a `describe("RecurringInvoicesService (cycle claim, B9)")`
block existed pre-F13 (name references the prior B9/#373 fix) asserting the claim-then-create
ordering and that a lost claim (`count: 0`) skips creation; it did not assert any outcome-column
write on a `create` throw (no such column write existed at PRE for this path — confirmed by the
absence of `lastRunStatus`/`lastError` anywhere in PRE's `generateInvoiceFromTemplate`).

### Tests at POST carrying the REG-B106 token

`apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts`
(`describe("failure/success outcome recording (R12-R15, B106)")`):

- `:175` — `"REG-B106 T17 — a create failure restores nextRunAt, records FAILED, and rethrows the
original error"` — asserts `generateInvoiceFromTemplate` rejects with the original thrown error
  AND `prisma.recurringInvoice.update` was called with
  `{where:{id:"ri-1"}, data: expect.objectContaining({nextRunAt: ri.nextRunAt, lastRunStatus:
"FAILED", lastError: expect.stringContaining("Customer not found")})}`; also asserts that write
  has no `lastRunAt` key and `prisma.invoice.update` was never called.
- `:198` — `"REG-B106 T17b — a failure AFTER the invoice exists records the billed-but-unfinalized
state and keeps the advanced nextRunAt"` — asserts the function still _resolves_ (not rejects)
  with `{id:"inv-1"}` when `invoice.update` (the link step) throws, that the recorded
  `lastError` contains both `"The invoice was created but the run could not be finalized"` and
  `"connection reset"`, and that the write has NO `nextRunAt` key (schedule not given back).
- `:221` — `"REG-B106 T18 — SUCCESS is recorded only after the invoice is created and linked"` —
  asserts call order `["claim", "create", "link", "status:SUCCESS"]` and that the SUCCESS write's
  `data` is exactly `{lastRunStatus:"SUCCESS", lastError:null}` with `updateMany` called exactly
  once (no extra `nextRunAt` write on the happy path).
- `:249` — `"REG-B106 T19 — the claim itself stamps a provisional FAILED outcome before the
invoice is created"` — asserts the claim `updateMany` call's `data` has `lastRunStatus:
"FAILED"` and a non-empty string `lastError`, alongside `nextRunAt`/`lastRunAt`.

`recurring-invoices.service.spec.ts` (existing file, extended): `"T20 (pin, R18): a lost claim
records no outcome either"` (asserts `prisma.recurringInvoice.update` not called when the claim
itself returns `count: 0`); the happy-path pin was relaxed from a blanket "update never called" to
"no second `nextRunAt` write" (quoted in full above under the diff), with the comment: "the pin's
real intent is 'no second nextRunAt write', so it is asserted directly rather than via a blanket
'never called'."

`apps/mobile/__tests__/recurring-invoices-helpers.test.ts`
(`describe("REG-B106 lastRunOutcome")`): `:70` `"T22a — no last run, or a run with no recorded
status → null"`; `:77` `"T22b — FAILED run → red pill with the error detail"`; `:89` `"T22c —
SUCCESS run → green pill"`.

`apps/web/e2e/30-recurring-standing.spec.ts:285` — `"REG-B106 web leg — after Run Now the
recurring-template card shows the recorded Succeeded outcome (R16 / T33)"` (T2, web-visible).

### The v1 run's own claims — INCLUDING A CLAIM THIS BRIEF DID NOT VERIFY AS RESOLVED

- `build-plan.md` close-out table lists three separate B106 rows for the claim-stamp, the
  create-catch, and the link/SUCCESS write, plus "Status constants exported" and the pin
  adjustments (T18/T20 above).
- RESUME.md ledger-flip intent: B106 → `proven` (T1).
- **The abandoned remediation plan's Finding #1** (`F13-remediation-abandoned/2026-09-03-F13-
remediation/build-plan.md:15`, quoted in full): _"`recurring-invoices.service.ts:240-251` — the
  B106 failure rollback restores `nextRunAt` UNCONDITIONALLY. v1's plan (WP-API-RI)
  compare-and-sets only the CLAIM (`updateMany({ where: { id, nextRunAt: <pre-claim> } })`) and
  specifies the rollback as a plain `update`; that leaves a race the claim's CAS was meant to
  close: a `runNow` or a concurrent tick that moves `nextRunAt` between the failed `create` and
  the restore is clobbered back to the pre-claim value, so the template fires again next tick and
  the customer is billed one extra cycle. This run adds the symmetric CAS on the rollback
  (decision of the 2026-09-03 planner, not a v1 mandate). `REG-B106 T17` asserts the plain form
  today, so the test encodes the defect."_ That remediation plan's own requirement `R1`
  (`build-plan.md:25`) and test package `TP1` (`:32-60`) specify rewriting the rollback to a
  compare-and-set `updateMany` (matching `data.nextRunAt` against the value the claim wrote) with
  a `{count:0}` fallback path — **this plan was abandoned and never merged.**
  Cross-checked against POST (`9e5ce526`, this batch's actual snapshot, quoted verbatim above
  under "Fix as implemented"): the rollback at `:240-252` is still the plain
  `this.prisma.forTenant().recurringInvoice.update({where:{id: ri.id}, ...})` form — no
  `updateMany`/CAS, no `where.nextRunAt` clause. `REG-B106 T17` at POST
  (`schedule-outcome.spec.ts:175-197`, quoted above) asserts exactly this plain-`update` shape
  (`expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({where:{id:"ri-1"}, data:
expect.objectContaining({...})})` — no `updateMany` assertion anywhere in T17/T17b). The
  abandoned plan's characterization of the test as "encoding the defect" is therefore consistent
  with what is present at POST today: the test proves the plain-update behavior, not a
  race-free one.
- `f13-v1-evaluation.md:162-176`: "**B106 — implemented & proven (with one plan-mandated safety
  property absent).**" (numbered flag 1, same finding as above) and flag 5: `"REG-B106 T18` ...
  is not deterministic under parallel jest workers while passing serially and in isolation; the
  production ordering is provably link-then-SUCCESS`" — this brief did not independently execute
  the suite (read-only, no test runs permitted) and cannot confirm or refute the flakiness claim.

---

## Harness

Mocks/fixtures the POST tests depend on:

- **`createMockPrisma`** — `apps/api/src/testing/prisma-mock.ts`. Model proxies relevant to this
  batch: `orderTemplate: modelProxy()` (`:133`), `orderTemplateItem: modelProxy()` (`:134`),
  `recurringInvoice: modelProxy()` (`:147`), `recurringInvoiceItem: modelProxy()` (`:148`). A
  comment at `:159` notes "model must exist on the object the default
  tenantTransaction/$transaction mocks [use]" and `tenantTransaction` (`:223`) "wraps
  `$transaction`with tenant context — behaves the same in tests" — i.e.`tenantTransaction(fn)`in the mock invokes`fn`against the same mocked model proxies rather than a separate
transaction-client stub, which is what lets B09/B92's`tx.orderTemplateItem.deleteMany`/`tx.recurringInvoiceItem.deleteMany`assertions in the specs read against the top-level`prisma.orderTemplateItem`/`prisma.recurringInvoiceItem`mocks directly (e.g.`order-templates.pricing-and-items.spec.ts:273`and`schedule-outcome.spec.ts:266`).
- **`OrdersService` mock in `order-templates.service.spec.ts` / `order-templates.pricing-and-
items.spec.ts`** — `pricing-and-items.spec.ts:41-49`:
  ```ts
  const realResolver = (OrdersService.prototype as any).resolveBuyerLinePrice;
  ordersService = {
    mergeAllPendingForCustomer: jest.fn().mockResolvedValue(null),
    loadActivePromotions: jest.fn().mockResolvedValue([]),
    getCustomerPriceHistory: jest.fn().mockResolvedValue({}),
    resolveBuyerLinePrice: jest.fn((...args: any[]) => realResolver(...args)),
  };
  ```
  This mock calls the REAL `resolveBuyerLinePrice` implementation (via
  `OrdersService.prototype`) rather than stubbing its return value — the B48 pricing proofs
  (T9-T16) therefore exercise the real tier/promo/sticky-upsell logic, not a canned price. The
  companion `order-templates.service.spec.ts` diff shows the SAME three new methods
  (`loadActivePromotions`, `getCustomerPriceHistory`, `resolveBuyerLinePrice`) had to be added to
  its OWN pre-existing `ordersService` mock object (previously just
  `{mergeAllPendingForCustomer: jest.fn()...}`) — this is the exact "stale mock" class
  `BUGFIX-NOTES.md` describes for this run's own predecessor incident ("F13's costliest blocker
  cascade was ONE stale mock (an `OrdersService` test double missing three methods the fix newly
  calls)").
- **Prisma mock shapes in `recurring-invoices.schedule-outcome.spec.ts`** — `invoices` collaborator
  mock (`:17,35-40`): `{create: jest.fn(), send: jest.fn(), sendEmail: jest.fn()}`, with
  `create` set per-test to resolve `{id:"inv-1"}` or reject with a specific error to drive
  T17/T17b/T18. `prisma.invoice.update` defaults to resolving `{id:"inv-1"}` in `beforeEach`
  (`:49`) and is overridden per-test (e.g. T17b rejects it to simulate the post-create finalize
  failure). The `template()` factory (`:19-32`) supplies a MONTHLY template fixture with
  `dayOfMonth: 15` and a single line item; tests override fields via `template({...overrides})`.
- **`recurring-invoices.service.spec.ts`'s own `cron continues past a failing template` pin**
  (T21) constructs its own `invoices` mock with `create: jest.fn().mockRejectedValueOnce(new
Error("boom")).mockResolvedValue({id:"inv-2"})` to drive exactly one of two due templates
  through the failure path while the other succeeds, and asserts `invoices.create` is called
  twice (i.e. the per-template try/catch in the cron loop is not disturbed by the B106 change).
- **DTO spec pipes** (`update-recurring-invoice.dto.spec.ts`, `update-order-template.dto.spec.ts`)
  construct a real `new ValidationPipe({whitelist:true, transform:true,
forbidNonWhitelisted:true})` and call `.transform(body, meta)` directly against the real DTO
  class — no service/controller involved; `update-recurring-invoice.dto.spec.ts` additionally
  uses a dynamic `require(...)` wrapped in try/catch specifically so the file loads (and T29 fails
  on its own assertion) even before the DTO file exists.
- **Mobile pure-logic tests** (`recurring-invoices-helpers.test.ts`) call
  `lastRunOutcome({lastRunAt, lastRunStatus, lastError})` directly — no mocks; it is a pure
  function over a plain object shape.
- **E2E harness** (`30-recurring-standing.spec.ts`) — not independently inspected beyond titles
  and the cross-test dependency noted below (read-only task scope; this is a T2/deploy-only file
  per policy, "never run it").

---

## Gaps

- **B106 rollback CAS**: the abandoned remediation plan's Finding #1 (quoted above) claims the
  plain, non-CAS `nextRunAt` rollback on a create-failure leaves a race — a `runNow` or a
  concurrent cron tick moving `nextRunAt` between the failed `create` and the restore would be
  clobbered back to the pre-claim value, letting the template fire again next tick and double-bill
  the customer. This brief confirms the POST code and POST `REG-B106 T17` both match the
  plain-`update` (non-CAS) shape the finding describes, but has NOT independently verified (no
  test execution performed, per task scope) whether this race is reachable in practice, whether
  the CAS is genuinely required given the claim's own `updateMany` already narrowing
  concurrent-claim windows elsewhere in the same function, or whether a mutation probe against the
  plain `update` would in fact turn any test red.
- **`REG-B106 T18` determinism under parallel jest workers**: the abandoned plan's evaluation
  (Finding #5, `f13-v1-evaluation.md:190-193`) claims this specific test is flaky under parallel
  workers ("verified by an isolated probe") while deterministic serially/in isolation. Not
  independently reproduced here (no test execution performed).
- **`e2e/30-recurring-standing.spec.ts` cross-test dependency**: the abandoned plan's evaluation
  (Finding #8, line `:203-204` of that file) claims the `REG-B106 web leg` test depends on state
  left by the `REG-B92` test running first in the same worker (`sharedTemplateId`), and per the
  spec file itself (`:294`, quoted above): `"the REG-B92 test did not leave a shared template id
— it must run first and succeed"` — the spec file's own comment confirms an execution-order
  dependency exists; whether that dependency is a latent flakiness risk under Playwright's default
  worker/ordering model was not assessed here.
- **`categoryTaxAmount: 0` on template-generated regulated lines**: both the register (B48 section)
  and `build-plan.md`'s close-out table flag this field is "left as-is, per plan" on the newly
  tier/promo-priced lines — this brief did not evaluate whether a regulated-category line priced
  through a promo/override should carry a non-zero category tax amount; it is called out only
  because the pricing basis changed underneath a field the fix did not touch.
- **Finding #7 (e2e cleanup comment) and Finding #2/#4 (pre-existing mock/fixture repairs) from
  the abandoned plan**: not independently re-checked against POST; only Finding #1 and the
  retokening (Finding #3, confirmed resolved above) were cross-referenced against the current
  snapshot.
- **Register's B09 API asymmetry** (Rounds 4-5 addition: `POST /order-templates/:id/items`
  excludes CUSTOMER while `DELETE /:id/items/:itemId` admits them, both also admitting DRIVER,
  filed separately as an authorization defect) — not addressed by any diff in this batch (neither
  `useAddTemplateItem`/`useRemoveTemplateItem` nor the controller's role guards on those two
  routes appear in `git diff --stat PRE POST`); this brief did not re-verify the asymmetry is
  still present at POST, only that nothing in the 38-file diff touches it.
- This brief is evidence-only; it does not judge whether F13's fixes correctly address B09/B46/
  B48/B92/B106, whether the abandoned plan's Finding #1 constitutes a real, exploitable defect, or
  what S2 (cause refutation) should prioritize — those are downstream calls.
