# S2 refutation — F13 (B09, B46, B48, B92, B106) over an already-built tree

> Adversarial pass. For every id BOTH the suspected cause and the implemented fix were assumed
> wrong and attacked. Read-only; no tests were executed, no git state changed. Every claim below
> was re-derived from the source at the two pinned shas, not from the S1 brief.
>
> - **PRE** = `d07697016bff73e6335e112ae87881ff6e2509c7` (master before the F13 build)
> - **POST** = `9e5ce526cca75dc4410e1c542cdf76b67b0739f7` (`origin/fix/F13-recurring-standing-v2`,
>   confirmed by `git rev-parse`)
> - Diff: 38 files, +6783 / −612.
> - Ledger `.claude/campaign/status/F13.jsonl` (PRE): all five rows `state:"queued"`, no PR, no
>   proof. Tiers: **B09 T2 · B46 T1 · B48 T1 · B92 T2 · B106 T1**.
>
> Verdict vocabulary is the schema's: cause `confirmed|refuted|undetermined`; fix
> `fixes-the-cause|partial|wrong-target|undetermined`; repro
> `real-repro|not-a-repro|no-jest-repro|undetermined`. **No fix proposals appear anywhere below.**

---

## B46 — MONTHLY recurring invoices re-fire every midnight

### Trace (PRE)

`git show PRE:apps/api/src/recurring-invoices/recurring-invoices.service.ts` lines 21-48:

```ts
21  private calcNextRunAt(frequency, dayOfWeek?, dayOfMonth?, from: Date = new Date()): Date {
27    const d = new Date(from);
28    d.setHours(0, 0, 0, 0);
29    d.setDate(d.getDate() + 1);          // always at least tomorrow
31    if (frequency === RecurringFrequency.MONTHLY) {
32      const dom = dayOfMonth ?? 1;
33      d.setDate(1);
34      d.setMonth(d.getMonth());          // reset to start of month
36      if (d.getDate() > dom) d.setMonth(d.getMonth() + 1);
37      d.setDate(Math.min(dom, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
38      return d;
39    }
```

Repro input `calcNextRunAt("MONTHLY", null, 15, new Date(2026, 6, 15))`:

| line  | state of `d`                                                         |
| ----- | -------------------------------------------------------------------- |
| 27-28 | `2026-07-15 00:00`                                                   |
| 29    | `2026-07-16`                                                         |
| 33    | `2026-07-01`                                                         |
| 36    | test is `d.getDate() > dom` → **`1 > 15` → false**, no month advance |
| 37    | `setDate(min(15, 31))` → `2026-07-15`                                |
| 38    | returns **`2026-07-15`** — the input date, unchanged                 |

Because `:33` unconditionally sets the day to 1 **before** `:36` reads it, `d.getDate()` at `:36`
is _always_ `1`, so the test is `1 > dom`. `dayOfMonth` is validated `1..28`
(`dto/create-recurring-invoice.dto.ts`), so `1 > dom` is false for every valid row and the
month-advance at `:36` is unreachable. The only inputs that could make it true are `dom <= 0`,
and those take a _different_ wrong path (see the "T1b" row below).

Downstream, `:174` feeds this value straight into the claim, and `:242` selects on
`nextRunAt: { lte: new Date() }` — a `nextRunAt` equal to or before the due date is re-selected
every midnight. The value is a **fixed point**: feeding `2026-07-15` back in returns `2026-07-15`
again, forever.

**Attempted disproof (failed).** Two escape hatches were checked and neither holds:

1. _"Maybe the `+1 day` at `:29` saves it."_ It does not for MONTHLY — `:33` throws that day away
   before `:36` reads it. It _does_ save the `dom = 31` case (`from = 2026-01-31` → `:29` gives
   Feb 1 → `:33` Feb 1 → `:37` clamps to Feb 28), which is why the dom-31 pin passes on PRE and is
   correctly demoted to an untokened pin (`recurring-invoices.service.spec.ts:241`).
2. _"Maybe it is only wrong late in the month."_ Also no. For `from` earlier in the month than
   `dom` (e.g. `from = 2026-07-10, dom = 15`) PRE returns `2026-07-15`, which is correct —
   that is the untokened pin at `recurring-invoices.service.spec.ts:234`. For `from` on or after
   `dom` (the normal steady state, since `from` _is_ the previous occurrence) PRE returns a date
   `<= from`. Since the cron always passes `ri.nextRunAt` as `from`, the steady state is always
   the broken branch. **The cause survives.**

### Cause verdict — `confirmed`

### Diverging line

`PRE apps/api/src/recurring-invoices/recurring-invoices.service.ts:33` (`d.setDate(1)`), which
makes the intended month-advance at `:36` dead; the wrong value leaves at `:38`.

### Fix verdict — `fixes-the-cause`

POST `recurring-invoices.service.ts:41-65` replaces the branch and moves the unconditional
`+1 day` (`:67-69`) _below_ the MONTHLY early return, so MONTHLY is decided from `from` itself:

```ts
53   const dom = Math.min(31, Math.max(1, Math.trunc(Number(dayOfMonth)) || 1));
54   const base = new Date(from); base.setHours(0,0,0,0);
56   const occurrence = (y, m) => new Date(y, m, Math.min(dom, new Date(y, m+1, 0).getDate()));
60   let next = occurrence(base.getFullYear(), base.getMonth());
61   while (next.getTime() <= base.getTime()) next = occurrence(next.getFullYear(), next.getMonth()+1);
64   return next;
```

Same repro through POST: `base = 2026-07-15 00:00`; `occurrence(2026, 6) = 2026-07-15`;
`15 Jul <= 15 Jul` → loop → `occurrence(2026, 7)` = **`2026-08-15`**. Strictly future, lands on
`dom`. The WEEKLY/BIWEEKLY tail (`:71-77`) is byte-identical to PRE `:41-47`.

A second, separately-motivated change at the call site, POST `:220-223`:

```ts
220  const now = new Date();
221  const dueAt = ri.nextRunAt ? new Date(ri.nextRunAt) : now;
222  const advanceFrom = dueAt.getTime() > now.getTime() ? dueAt : now;
223  const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, advanceFrom);
```

This is load-bearing and _not_ redundant with the branch fix: for a row frozen months in the past
by live B46, `calcNextRunAt(from = ri.nextRunAt)` with the corrected branch still returns a date
in the past, and the cron would re-select nightly through the whole backlog, minting a real
customer invoice per night. `max(dueAt, now)` makes the claim strictly future in one step.

### Repro verdict per test

All in `apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts` (new at POST).
Verdicts derived by reading each assertion and computing the value PRE would produce.

| Test                                                    | PRE value                                                                                                                                                             | Assertion                               | Verdict                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:62` **T1** — next occurrence strictly after `from`    | `2026-07-15` (month 6)                                                                                                                                                | `getMonth() === 7`                      | **real-repro**                                                                                                                                                  |
| `:76` **T1b** — corrupt `dayOfMonth` 0/−3 clamped       | `dom=0`: `:36` `1>0` **true** → Aug 1 → `setDate(min(0,31))` = `setDate(0)` = **2026-07-31**. `dom=−3` → `setDate(−3)` = **2026-07-28**                               | expects Aug 1 for both, and both equal  | **real-repro** (fails on PRE) — but note it proves a hazard the _new_ loop would introduce (non-termination), not B46's symptom                                 |
| `:89` **T3** — Dec → Jan next year                      | `2026-12-15`                                                                                                                                                          | expects `2027`/month 0                  | **real-repro**                                                                                                                                                  |
| `:96` **T5** — time-of-day treated as calendar day      | `2026-07-15 00:00`                                                                                                                                                    | expects month 7                         | **real-repro**                                                                                                                                                  |
| `:104` **T6** — 12 chained cycles strictly advance      | cycle 1: `Jan 15 → Jan 15`                                                                                                                                            | `next > current`                        | **real-repro** (fails on the first iteration)                                                                                                                   |
| `:135` **T7** — claim is strictly future                | `from` = today 00:00 → PRE returns **the 15th of the current month**. Evaluated 2026-09-04, that is `2026-09-15`, which **is** `> Date.now()`, and `getDate() === 15` | `claimed > before` and `getDate()===15` | **not-a-repro** — passes on PRE today. It only goes red on calendar days ≥ `dom` (the 15th). Calendar-conditional: a _flaky_ proof, not a false one             |
| `:153` **T7b** — months-overdue claimed into the future | `from` = today − 8 months → PRE returns the 15th of that month, ~8 months in the past                                                                                 | `claimed > before`                      | **real-repro**, and the only test that is red on the `advanceFrom` change alone (with the branch fixed but `from = ri.nextRunAt`, it still returns a past date) |

**Id-level roll-up: `real-repro`** — T1/T3/T5/T6/T7b fail on PRE by an assertion on the wrong
returned `Date`, which is exactly B46's wrong value.

Untokened pins that pass on PRE and must keep passing (verified by trace, not by running):
`recurring-invoices.service.spec.ts:234` (T4, same-month `from` earlier than `dom`), `:241` (T2,
dom-31 clamp Jan 31 → Feb 28 → Mar 31), `:272/:279/:286` (T8, WEEKLY/BIWEEKLY unchanged).

### Residual defects

1. **T7 is calendar-conditional** (`schedule-outcome.spec.ts:135-151`). It derives `due` from
   today, so whether it would have been red on PRE depends on the day of the month the suite runs.
   It passes on PRE today (2026-09-04). Its sibling T7b is calendar-robust; T7 is not.
2. **Timezone convention split, not addressed.** `calcNextRunAt` builds _local_-midnight dates
   (`new Date(y, m, d)`, POST `:58`), while the B92 edit form writes _UTC_ midnight
   (`RecurringInvoiceForm.tsx:309`, `new Date("YYYY-MM-DD").toISOString()`), and mobile renders
   `nextRunAt` through a UTC calendar-date helper
   (`apps/mobile/app/(operator)/recurring-invoices/[id].tsx:50-53` comment). On a server with a
   positive UTC offset the cron-written date renders one day early on every surface. Pre-existing
   at PRE (same local-midnight construction), untouched by the fix, and invisible to the tests
   because every assertion uses local getters (`getMonth()`, `getDate()`).
3. **Missed cycles are silently not billed.** `advanceFrom = max(dueAt, now)` (POST `:222`) is a
   deliberate semantics decision documented at `:212-219`, but no test asserts the _dropped_
   cycles — T7b only asserts the claim is future. A row eight months behind produces exactly one
   invoice with no record that seven cycles were skipped.
4. `ri.nextRunAt ? … : now` (POST `:221`) is dead: `RecurringInvoice.nextRunAt` is a
   non-nullable `DateTime` (`apps/api/prisma/schema.prisma:2799`).

### Fix-shape facts

- The `dom` clamp (`:53`) exists solely to keep the new `while` loop terminating; an unclamped
  `dom <= 0` makes `occurrence(y, m)` land in month `m−1`, and `next <= base` stays true forever —
  an event-loop hang taking the cron and the whole API process with it. The clamp is therefore
  load-bearing for the fix, not defensive polish. T1b is its only guard.
- `Math.trunc(Number(dayOfMonth)) || 1` folds `NaN`, `null`, `undefined` and `0` all to `1`.
- Clamp ceiling is 31 while both DTOs cap `dayOfMonth` at 28 (`create-recurring-invoice.dto.ts`,
  and `UpdateRecurringInvoiceDto extends PartialType(CreateRecurringInvoiceDto)`), so 29-31 is
  reachable only from legacy or direct-DB rows.

---

## B48 — Standing-order reorder bills raw list price

### Trace (PRE)

`git show PRE:apps/api/src/order-templates/order-templates.service.ts:355-380`:

```ts
355  const tenantId = this.prisma.getTenantId();
356  let subtotal = 0;
357  const lineItemsData = allowedItems.map((item) => {
358    const product = productMap.get(item.productId);
360    const unitPrice = Number(product.pricePerUnit);
364    const itemSubtotal = computeLineSubtotal({ unitPrice, qty: item.qty });
365    subtotal = roundMoney(subtotal + itemSubtotal);
366    return { productId: item.productId, qty: item.qty, unitPrice, subtotal: itemSubtotal, … };
```

Repro: customer at `pricingTier = 2`, product `pricePerUnit = 10`, `priceTier2 = 8`, template line
`qty = 2`. PRE: `unitPrice = 10` (`:360`), `itemSubtotal = 20` (`:364`), order `subtotal = 20`.
Expected (what the same customer's own checkout produces): `unitPrice = 8`, `subtotal = 16`.

Independently verified that nothing else in the PRE function reaches the ladder: no
`customerPrice`, no `pricingTier`, no `loadActivePromotions`, no `getCustomerPriceHistory`, no
`resolveBuyerLinePrice` call exists anywhere between `:317` (function open) and `:395`
(`order.create`). The three reachable callers are the 06:00 cron (`:294 @Cron("0 6 * * *")`), the
operator "Generate now" and the buyer "Reorder", all funnelling through this one function.

**Attempted disproof (failed).** Checked whether a later stage re-prices: `order.create` at
`:395` writes `lineItemsData` verbatim, and the tax block at `:386-389` only multiplies the
subtotal. No re-price exists. **The cause survives.**

### Cause verdict — `confirmed`

### Diverging line

`PRE apps/api/src/order-templates/order-templates.service.ts:360` —
`const unitPrice = Number(product.pricePerUnit);`

### Fix verdict — `fixes-the-cause`

POST `:397-431` loads the same three inputs the interactive path loads and calls the same
resolver:

```ts
397  const customerRecord = await …customer.findUnique({ where:{id: template.customerId}, select:{pricingTier:true} });
401  const defaultTier = customerRecord?.pricingTier ?? 1;
402  const customerPrices = await …customerPrice.findMany({ where:{customerId, productId:{in: productIds}} });
406  const cpTier = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));
407  const activePromos = await this.ordersService.loadActivePromotions(UserRole.CUSTOMER);
408  const priceHistory = await this.ordersService.getCustomerPriceHistory(template.customerId);
415    const tierForProduct = cpTier.get(item.productId) ?? defaultTier;
420    const upb = Number(product.unitsPerBox ?? 0);
422    const qtyPieces = upb > 1 ? item.qty * upb : item.qty;
423    const resolved = this.ordersService.resolveBuyerLinePrice(product, tierForProduct,
             activePromos, qtyPieces, qtyUnits, priceHistory[…]?.lastPrice ?? null,
             { boxes: null, pieces: null, unitsPerBox: upb });
434    const itemSubtotal = computeLineSubtotal({ unitPrice: resolved.unitPrice, qty: item.qty, freeUnits: resolved.freeUnits });
```

Same repro through POST: `tierForProduct = 2` → `resolveBuyerLinePrice` (`orders.service.ts:141`)
→ no remembered price → `applyBestPromotion` with `[]` → no promo → `tierForProduct !== 1` →
`{unitPrice: 8, originalPrice: 10, priceType: SPECIAL, freeUnits: 0}`. `computeLineSubtotal` takes
the non-boxed branch (`pricing.ts:118` `boxesPiecesProvided` is false) → **`16`**. Order
`subtotal = 16`, `tax = 1.6`, `total = 17.6`.

**Fidelity to the golden reference was checked line-by-line and holds:**

| Property        | `orders.service.create` (reference)                                                                                                                                           | `createOrderFromTemplate` (POST)                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| tier map        | `:1765` `cp.pricingTier` keyed by productId                                                                                                                                   | `:406` identical                                    |
| tier resolution | `:1888` `cpMap.get(id) ?? defaultTier`                                                                                                                                        | `:415` identical                                    |
| `qtyPieces`     | `:1910` `boxes != null ? qty : upb>1 ? qty*upb : qty`                                                                                                                         | `:422` box-unaware form, identical                  |
| `qtyUnits`      | `:1915` `boxes != null ? boxes : qty`                                                                                                                                         | `:421` `item.qty`, identical for a box-unaware line |
| denomination    | `:1950` `{boxes, pieces, unitsPerBox: upb}`                                                                                                                                   | `:430` `{null, null, upb}`                          |
| subtotal        | `:1962` `computeLineSubtotal({unitPrice, qty, boxes, pieces, unitsPerBox, freeUnits})` — with `boxes/pieces` null this takes the same branch as `:434` (`pricing.ts:118-129`) | `:434` equivalent                                   |

Visibility widening is the minimum: `orders.service.ts:117` (`loadActivePromotions`) and `:141`
(`resolveBuyerLinePrice`) lost `private`; `getCustomerPriceHistory` was already public at PRE
(`PRE orders.service.ts:528`).

### Repro verdict per test

`apps/api/src/order-templates/order-templates.pricing-and-items.spec.ts` (new at POST). The mock
delegates to the **real** resolver (`:41,:49`) and the real `computeLineSubtotal`, so every money
assertion is arithmetic, not a mock echo.

| Test                                                    | PRE value                                                              | POST value                                                             | Verdict        |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------- |
| `:90` **T9** tier 2 → `priceTier2`                      | `unitPrice 10`, `subtotal 20`, `tax 2`, `total 22`, no `priceType` key | `8 / 16 / 1.6 / 17.6`, `SPECIAL`                                       | **real-repro** |
| `:119` **T10** `CustomerPrice` tier 3 beats default     | `10`                                                                   | `7`, `SPECIAL`                                                         | **real-repro** |
| `:145` **T11** null override falls to default tier      | `10`                                                                   | `8`                                                                    | **real-repro** |
| `:165` **T12** best active PERCENT promo                | `10`, subtotal `30`                                                    | `9`, `PROMO`, subtotal `27`                                            | **real-repro** |
| `:194` **T13** BUY_N_GET_M free units                   | subtotal `30`, no `promoFreeUnits` key                                 | `promoFreeUnits 1`, subtotal `20`                                      | **real-repro** |
| `:215` **T14** boxed qty bills as whole boxes           | `unitPrice 24`, subtotal `48`; `resolveBuyerLinePrice` never called    | `20 / 40`; called with `(product, 2, [], 24, 2, null, {null,null,12})` | **real-repro** |
| `:240` **T15** sticky above-list upsell wins            | `10`                                                                   | `12`, `MANUAL`                                                         | **real-repro** |
| `:259` **T16** tier 1 persists STANDARD / null original | no `priceType`/`originalPrice` keys at all                             | `STANDARD` / `null`                                                    | **real-repro** |

**Id-level roll-up: `real-repro`.** Every B48 title fails on PRE on a money value or a persisted
price field, not on a shape.

Untokened money pin: `order-templates.service.spec.ts:411` (T16) asserts only
`{unitPrice: 10, subtotal: 20}` for the tier-1 no-promo case — genuinely unchanged across PRE/POST,
correctly scoped (its header at `:405-408` explains why `priceType`/`originalPrice` are excluded).

### Residual defects

1. **The fix can make a standing order MORE expensive than PRE.** `priceHistory[…].lastPrice`
   (POST `:429`) feeds the sticky-upsell branch at `orders.service.ts:178-185`: a remembered
   _above-list_ price becomes a `MANUAL` upsell that overrides the tier **and** beats every promo.
   T15 (`:240-257`) asserts exactly this: list 10, remembered 12 → the template line bills **12**.
   In the interactive path a human is present when that price is applied; on the 06:00 cron
   (`:294`) nobody is. The register framed B48's correct outcome as "a strictly lower or equal
   amount whenever a discount, override, or promo applies" — the shared-resolver approach imports
   a rule that can move the price _up_, and no test pins the cron-triggered case against the
   operator-triggered one.
2. **`categoryTaxAmount: 0` (POST `:451`) is unchanged** while the pricing basis under it moved.
   The interactive path computes a real per-line category tax
   (`orders.service.ts:1972` onward, keyed off `qtyPieces`); template-generated regulated lines
   still write 0. Pre-existing at PRE `:377`, explicitly "left as-is, per plan", but it is now the
   only remaining divergence from the golden path on the same line object.
3. **Four extra awaited round-trips per template inside the 06:00 cron loop** (`:397`, `:402`,
   `:407`, `:408`), all outside any cache and inside the per-tenant `for` loop at `:319`. No
   correctness claim; a load fact.
4. `subtotal = roundMoney(subtotal + itemSubtotal)` per line (POST `:439`) vs the reference's
   plain `subtotal += itemSubtotal` (`orders.service.ts:1970`). Both PRE and POST round here, so
   this is not a regression, but it is a documented divergence from the money oracle.

### Fix-shape facts

- The B48 change widened `createOrderFromTemplate`'s collaborator surface from one
  `OrdersService` method to four. That is the exact "stale mock" class `BUGFIX-NOTES.md` records
  as F13's own costliest blocker cascade; see **Harness** below for the two spec files that had
  to be repaired and the one that was left half-repaired.
- `resolveBuyerLinePrice` is called through `this.ordersService.…` (an injected instance), while
  both spec files call it through `OrdersService.prototype` unbound. That works only because the
  method body uses no `this` (`orders.service.ts:141-213` — verified: `listPrice`, `tierBase`,
  `getTierPrice`, `applyBestPromotion` are all free functions/params). Any future `this.` inside
  it breaks both suites at once.

---

## B09 — Standing-order edits silently drop item changes

### Trace (PRE)

Three layers, all of which must be crossed for an item edit to persist, and all three refuse:

1. **Web** `PRE apps/web/app/(dashboard)/customers/[id]/StandingOrderModal.tsx:179-187`:

```tsx
179  if (isEditing && template) {
180    // Edit: only update template fields (not items in this flow — items managed separately)
181    updateTemplate.mutate(
182      { id: template.id, name: name.trim(), daysOfWeek: selectedDays, notes: notes.trim() || undefined },
```

`lineItems` — the state the modal's product-search / qty-stepper UI writes — is read nowhere in
this branch. It is read in the create branch (`:195` onward) and by the ≥1-item guard at
`:173-176`, which is what makes the drop silent rather than a validation error. 2. **DTO** `PRE apps/api/src/order-templates/dto/update-order-template.dto.ts:3-13` — the class
carries `name`, `daysOfWeek`, `isActive`, `notes`. No `items`. With the global pipe's
`forbidNonWhitelisted`, an `items` key on the PATCH is a **400**, not a silently ignored field. 3. **Service** `PRE apps/api/src/order-templates/order-templates.service.ts:166-183` — `update()`
maps exactly those four scalars into `orderTemplate.update`. No item handling of any kind.

Repro: operator opens the edit modal, changes a qty from 1 to 3 and adds a second product, clicks
Save. Body sent: `{id, name, daysOfWeek, notes}`. Server returns 200. Toast reads "Standing order
updated" (`:190`). Template items after save are byte-identical to before.

**Attempted disproof (failed).** Checked whether the modal reaches the item endpoints instead:
`useAddTemplateItem` / `useRemoveTemplateItem` exist (`apps/web/lib/api/order-templates.ts`) and
`StandingOrderModal.tsx` imports neither at PRE. **The cause survives**, and it is a three-layer
absence, not one.

### Cause verdict — `confirmed`

### Diverging line

`PRE apps/web/app/(dashboard)/customers/[id]/StandingOrderModal.tsx:181-187` — the `mutate`
payload omits `items`. Backstopped by `PRE dto/update-order-template.dto.ts:3-13` (no field) and
`PRE order-templates.service.ts:166-183` (no handling).

### Fix verdict — `fixes-the-cause`

All three layers are crossed at POST:

- `StandingOrderModal.tsx:42-46` adds `itemSignature`, `:206` computes `itemsChanged`, `:213-221`
  conditionally spreads `items` into the PATCH body. `LineItem.notes` added at `:33` and seeded
  from the loaded template at `:115`.
- `dto/update-order-template.dto.ts:25-31` adds `items?: OrderTemplateItemDto[]` with
  `@IsOptional @IsArray @ArrayMinSize(1) @ValidateNested({each:true}) @Type(() => OrderTemplateItemDto)`;
  `OrderTemplateItemDto` exported from `create-order-template.dto.ts:13` (was module-private).
- `order-templates.service.ts:183-217`: `!dto.items` short-circuits to the old scalar update
  (`:184`); otherwise product existence is validated for the whole set _before any write_
  (`:192-198`) and `deleteMany` + nested `create` run inside one `tenantTransaction` (`:200-217`).

Same repro through POST: `itemSignature(lineItems) !== itemSignature(template.items)` → `items`
carried → DTO whitelists `{productId, qty, notes}` → `update()` validates both productIds exist →
one transaction deletes the old rows and creates `[{p1, qty 3}, {p2, qty 1}]` with `tenantId`
stamped. Saved template reflects the edit.

The `itemsChanged` gate (`:206`) is a deliberate deploy-window property, reasoned at `:197-205`:
a scalar-only edit keeps the pre-F13 body shape, so web-ahead-of-api survives for every edit
except an item edit.

### Repro verdict per test

| Test                                                                                                              | PRE behavior                                                                                                                                                             | Verdict                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `dto/update-order-template.dto.spec.ts:18` **T23** — accepts `items`, whitelists `productId`/`qty`                | PRE DTO has no `items` field; the pipe is constructed with `forbidNonWhitelisted: true` (`:11-15`) → `transform` **rejects with 400**, so `resolves.toMatchObject` fails | **real-repro**                                                 |
| `order-templates.pricing-and-items.spec.ts:273` **T25** — atomic replace, `deleteMany` before the write           | PRE `update()` ignores `items`: `tenantTransaction` never called (0 ≠ 1), `calls` is `["update"]` not `["deleteMany","update"]`, `updateArg.data.items` undefined        | **real-repro**                                                 |
| `order-templates.pricing-and-items.spec.ts:313` **T26** — validates every productId before writing                | PRE `update()` resolves; `rejects.toBeInstanceOf(BadRequestException)` fails                                                                                             | **real-repro**, but it proves a _new_ guard, not B09's symptom |
| `apps/web/e2e/30-recurring-standing.spec.ts:90` **T28** — the modal persists item adds and qty changes end-to-end | deploy-only; no jest equivalent exists                                                                                                                                   | **no-jest-repro** (T2, spec 30)                                |

**Id-level roll-up: `real-repro`** — T23 and T25 go red on PRE on the persisted result. **With
the caveat that the API half is what jest proves.** No jest test asserts the _modal's_ PATCH body,
which is the layer the register's symptom names; that is T28's job alone, and B09 is a T2 row.

Untokened pins that pass on both sides: `dto/update-order-template.dto.spec.ts:26,30,36,42`
(empty array / qty 0 / client `unitPrice` / no-`items` body — the header at `:24-25` correctly
notes they already pass at PRE because the whole key is rejected);
`order-templates.service.spec.ts:414` (T27, PATCH with no `items` key leaves replacement untouched).

### Residual defects

1. **The register's Rounds 4-5 API asymmetry is not closed — it is inverted.** At POST
   (and identically at PRE — the file is untouched by the diff)
   `order-templates.controller.ts:66-68` restricts `POST /:id/items` to `OPERATOR`, while
   `:77-79` `DELETE /:id/items/:itemId` and `:48-50` `PATCH /:id` both admit
   `OPERATOR, CUSTOMER`. B09's fix routes item _replacement_ (which includes adding) through the
   PATCH, so a CUSTOMER can now add items via `PATCH` while still being 403'd on the dedicated
   add-item route. Ownership is enforced for that path
   (`order-templates.service.ts:106-115 updateForUser` — a CUSTOMER may only touch their own
   template), so it is not an authorization hole; it is an unresolved inconsistency the register
   filed separately.
2. **The register's DRIVER claim is refuted at both shas.** The register states both item routes
   "also admit DRIVER". `PRE order-templates.controller.ts:66-86` and
   `POST :66-86` both list only `OPERATOR` / `OPERATOR, CUSTOMER`. `UserRole.DRIVER` appears in
   neither decorator.
3. `useAddTemplateItem` / `useRemoveTemplateItem` (`apps/web/lib/api/order-templates.ts:92,107`)
   remain uncalled by any component — the fix left the dead hooks in place and went through PATCH.
4. Replacement mints new `OrderTemplateItem` ids on every item-carrying save. Nothing in the repo
   holds an `OrderTemplateItem.id` foreign key (`Order` references `templateId`, not item ids), so
   no reference breaks — but the `itemsChanged` gate at `:206` is the only thing preventing churn
   on every save, and it compares against `template.items` from the client's query cache rather
   than a server read.

### Fix-shape facts

- `itemSignature` (`:42-46`) sorts the mapped strings, so it is a genuine multiset comparison —
  a remove-and-re-add of the same product/qty/notes correctly reads as "no change".
- `i.notes ?? ""` normalises `null` (API) and `undefined` (modal state) to the same token, so the
  seeded and edited lists compare equal when notes are untouched.
- `notes: li.notes` is sent as `undefined` for note-less lines; `JSON.stringify` drops the key, so
  `@IsOptional() @IsString() notes?` passes.

---

## B92 — Recurring invoice templates cannot be edited after creation

### Trace (PRE)

Two independent defects sharing one id:

1. **No affordance.** `apps/web/app/(dashboard)/invoices/recurring/` at PRE contains `page.tsx`
   and `new/page.tsx` only; `[id]/edit/page.tsx` and `_components/RecurringInvoiceForm.tsx` are
   both **new files** in `git diff --stat PRE POST`. `PRE page.tsx` renders Run Now and
   Pause/Activate per card and no Edit control. `useRecurringInvoice` /
   `useUpdateRecurringInvoice` exist and are called by nothing.
2. **The PATCH it would reach is unvalidated.** `PRE recurring-invoices.controller.ts:40-43`:

```ts
40  @Patch(":id")
41  update(@Param("id") id: string, @Body() dto: Partial<CreateRecurringInvoiceDto>) {
42    return this.recurringInvoicesService.update(id, dto);
43  }
```

`Partial<T>` is a TypeScript mapped type. It emits `Object` into `design:paramtypes`, and Nest's
`ValidationPipe` skips any body whose metatype is `Object`/absent — so no validator, no
`whitelist`, no `forbidNonWhitelisted` ran on this endpoint at all. `PRE service.update()`
(`:103-140`) then spreads whatever arrives, and its item replacement (`:106-110` `deleteMany`,
then `:112` `update` with a nested `create`) is **two separate statements outside any
transaction** — a failure between them leaves the template with zero items.

Repro: an operator wants to change a typo or reschedule an existing template. There is no control
anywhere in web or mobile that reaches `PATCH /recurring-invoices/:id`. The endpoint is live and
functional and unreachable.

**Attempted disproof (failed).** Checked whether the list page's Pause/Resume goes through the
PATCH — it does not: `deactivate` is `DELETE /:id` (`controller :45-48`) and `activate` is
`POST /:id/activate` (`:53-56`), and `apps/web/lib/api/invoices.ts` (POST comment at `:849-856`)
records that the `{isActive:true}` PATCH approach never persisted. **The cause survives.**

### Cause verdict — `confirmed`

### Diverging line

An **absence**, not a defective line: no `apps/web/app/(dashboard)/invoices/recurring/[id]/`
route exists at PRE. The one defective _line_ in the pair is
`PRE apps/api/src/recurring-invoices/recurring-invoices.controller.ts:41`
(`@Body() dto: Partial<CreateRecurringInvoiceDto>`).

### Fix verdict — `fixes-the-cause`

- New route `apps/web/app/(dashboard)/invoices/recurring/[id]/edit/page.tsx` (71 lines) consuming
  `useRecurringInvoice` / `useUpdateRecurringInvoice`, plus a shared
  `_components/RecurringInvoiceForm.tsx` (556 lines) extracted from `new/page.tsx` (−530 lines)
  with a `mode: "create" | "edit"` switch. Edit link added to every list card
  (`page.tsx:206-213`).
- `dto/update-recurring-invoice.dto.ts` (new) —
  `export class UpdateRecurringInvoiceDto extends PartialType(CreateRecurringInvoiceDto) {}`; a
  real class, so `design:paramtypes` carries it and the global pipe validates and whitelists.
  `isActive` deliberately absent.
- `recurring-invoices.controller.ts:42` retyped to `UpdateRecurringInvoiceDto`.
- `service.update()` rebuilt at `:133-175`: scalars hoisted into `data`, `!dto.items`
  short-circuit at `:147`, item replacement inside one `tenantTransaction` at `:154-174` with
  `tenantId` stamped on nested creates (`:168`).

Same repro through POST: the card's Edit button links to `/invoices/recurring/<id>/edit`; the page
loads the template, `RecurringInvoiceForm` in `edit` mode pre-fills, and Save issues a validated
PATCH.

### Repro verdict per test

| Test                                                                                                                                    | PRE behavior                                                                                                                                                                                                                                                                                                                                                              | Verdict                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `dto/update-recurring-invoice.dto.spec.ts:25` **T29** — a partial `{notes}` body validates                                              | The file guards its import with `require`+`try/catch` (`:9-15`), so on PRE `Dto` is `undefined`. `meta.metatype` is then `undefined`, and `ValidationPipe.transform` **skips validation entirely and returns the value** — so `resolves.toEqual({notes:"x"})` **passes**. The only failing assertion is `expect(Dto).toBeDefined()` at `:26`, i.e. "the new file exists". | **not-a-repro** — it asserts the fix's own existence, not the bug's wrong value                           |
| `recurring-invoices.schedule-outcome.spec.ts:266` **T31** — item replace in one `tenantTransaction`, `tenantId` stamped                 | PRE `update()` calls `deleteMany` then `update` at top level; `tenantTransaction` is never called, so `toHaveBeenCalledTimes(1)` fails (0). `calls` would still be `["delete","update"]` and `tenantId` is still stamped (`PRE :133`).                                                                                                                                    | fails on PRE, but **on the atomicity property only** — a hardening addition, not B92's registered symptom |
| `apps/web/e2e/30-recurring-standing.spec.ts:201` **T32** — the edit page persists a schedule + notes change through the validated PATCH | deploy-only                                                                                                                                                                                                                                                                                                                                                               | **no-jest-repro** (T2, spec 30)                                                                           |

**Id-level roll-up: `no-jest-repro`.** B92's registered symptom — "no UI reaches the working
PATCH" — has **no** jest proof at POST. T29 is an existence assertion; T31 proves transactionality.
Neither would have gone red on PRE for the reason B92 was filed. The symptom is proven only by
e2e T32, consistent with the T2 tier on the ledger row.

Untokened pins in the DTO spec (`:30,:34,:38,:44`) inherit T29's defect: on PRE, `metatype` is
`undefined`, the pipe short-circuits, and every `rejects.toMatchObject({status:400})` assertion
fails for "the class does not exist", not because PRE accepted a bad body.

### Residual defects

1. **Nothing at POST proves the controller actually binds the DTO.** The B92 sub-defect is
   specifically that a _mapped type in the `@Body()` position_ is skipped by the pipe. Both DTO
   specs construct their own `new ValidationPipe(...)` and call `.transform(body, {metatype: Dto})`
   directly — they never touch `RecurringInvoicesController`. Reverting `controller.ts:42` back to
   `Partial<CreateRecurringInvoiceDto>` would leave every jest test in the batch green; only the
   e2e leg would notice, and only for a body that the service happens to reject downstream.
   The same is true of the B09 DTO spec (`update-order-template.dto.spec.ts:16`).
2. **The edit form always writes `nextRunAt`.** `RecurringInvoiceForm.tsx:309` puts
   `new Date(nextRunAt).toISOString()` in the DTO unconditionally, and `service.update():145`
   maps it whenever truthy. B92 therefore creates the first UI-reachable writer of `nextRunAt`
   outside the cron claim — which is what makes the B106 race below operator-reachable rather than
   theoretical. See the B106 race section.
3. **UTC/local convention split** on that write: the form parses `"YYYY-MM-DD"` (UTC midnight)
   while `calcNextRunAt` writes local midnight (`recurring-invoices.service.ts:58`). Same residual
   as B46 #2, reached from the other direction.
4. `apps/web/lib/api/invoices.ts:849-856` rewrites the `useActivateRecurringInvoice` doc comment to
   claim `{isActive:true}` is now "a 400". True at POST via the whitelist; it was _silently
   ignored_ at PRE, not rejected. The comment describes POST, so it is accurate — noted only
   because the two behaviors differ and no test covers the transition.

### Fix-shape facts

- `PartialType` comes from `@nestjs/mapped-types` (a runtime class factory), not the TS `Partial<>`
  — that is precisely why the fix works where the original typing did not.
- Extracting `RecurringInvoiceForm` deleted 530 lines from `new/page.tsx` and added 556 to the
  shared component: the create path is now covered by the edit path's code. No jest test covers
  either page.

---

## B106 — Recurring cycle claimed before invoice creation, failure silently skips the bill

### Trace (PRE)

`PRE recurring-invoices.service.ts:169-223` + the cron at `:227-266`:

```ts
174  const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, ri.nextRunAt);
175  const claimed = await …recurringInvoice.updateMany({
176    where: { id: ri.id, nextRunAt: ri.nextRunAt },
177    data: { nextRunAt, lastRunAt: new Date() },        // ← cycle consumed, timestamp stamped
178  });
179  if (claimed.count === 0) { …; return null; }
184  const invoice = await this.invoicesService.create({ … });   // ← unguarded; throws here
…
217  await …invoice.update({ where: {id: invoice.id}, data: {recurringInvoiceId: ri.id} });
…
253  } catch (err) {
254    totalFail++;                                       // ← in-memory only
255    this.logger.error(`… Failed to generate invoice …`);
258  }
```

Repro: a WEEKLY/BIWEEKLY template whose `invoicesService.create` throws (a `ConflictException` on
a `P2002` invoice-number collision, `invoices.service.ts:530-531`; a deleted customer, `:317`;
any DB fault). The claim at `:175-178` has already committed `nextRunAt` advanced and
`lastRunAt = now`. The throw unwinds to the cron's `catch` at `:253`, which increments a local
counter and logs. **Nothing is written.** `RecurringInvoice.lastRunStatus` and `lastError` already
existed in the PRE schema (`PRE apps/api/prisma/schema.prisma:2805-2806`, with the comment "F13
wires the writes") and were written by nothing on this path. The web list page rendered only
`Last run <date>` from the freshly-stamped `lastRunAt` — a positive-looking timestamp for a cycle
that produced no invoice, with no retry and no signal.

**Attempted disproof (failed, twice).**

1. _"Is the claim-first ordering itself the bug?"_ No — it is the deliberate #373 fix
   (`git blame PRE` attributes `:170-183` to `1fd21f128`, 2026-08-20) trading duplicate invoices
   for one missed cycle. The register's own verifier note says so. The defect is the _unsurfaced_
   outcome.
2. _"Does the caller recover?"_ `runNow` (`PRE :158-165`) is the only other caller and it just
   rethrows to the controller. No compensating write exists anywhere.

**The cause survives.**

### Cause verdict — `confirmed`

### Diverging line

`PRE apps/api/src/recurring-invoices/recurring-invoices.service.ts:184` — the unguarded
`await this.invoicesService.create(…)` following the already-committed claim at `:175-178`; the
loss becomes permanent at the cron's write-nothing `catch`, `PRE :253-258`.

### Fix verdict — `partial`

The outcome-recording half is real and correct. Three writes at POST:

- `:224-232` the claim now also stamps `lastRunStatus: FAILED` + `lastError: RUN_INTERRUPTED_ERROR`
  — so a process crash between claim and create leaves an honest FAILED behind.
- `:239-275` `create` wrapped; on throw, `nextRunAt` is restored, the real error recorded (sliced
  to 500), and the error rethrown.
- `:293-334` the link + `lastRunStatus: SUCCESS` write happen only after the invoice exists;
  a post-create finalize failure records `RUN_UNFINALIZED_ERROR` and **never** restores
  `nextRunAt` (the cycle is billed).

Same repro through POST: create throws → `recurringInvoice.update({where:{id}, data:{nextRunAt:
ri.nextRunAt, lastRunStatus:"FAILED", lastError:"Customer not found"}})` → rethrow → the card
renders a red **Failed** pill plus the error and a "use Run Now to retry" hint
(`apps/web/app/(dashboard)/invoices/recurring/page.tsx:176-193`). The cycle is retryable and
visible. That is a genuine fix for the registered symptom.

**It is `partial`, on two counts that are both attributable to this batch's own code:**

**(a) The rollback is a non-CAS plain `update`** (`:263-268`) inside a function whose _claim_
is a CAS specifically because concurrent writers exist. It stomps `nextRunAt` **and**
`lastRunStatus`/`lastError` unconditionally. See the dedicated race section below — verdict
`real`.

**(b) The provisional FAILED is operator-visible during every normal run, wearing a retry hint.**
Between `:232` (claim commits `FAILED` + `RUN_INTERRUPTED_ERROR`) and `:302-305` (SUCCESS), the row
reads FAILED. That window spans `invoicesService.create` _and_, when `autoSend` is on, the
`sendEmail` network call at `:284` — seconds, not milliseconds. In that window
`apps/web/lib/api/invoices.ts:783-785`:

```ts
export function isRetryableRunFailure(lastError?: string | null): boolean {
  return !!lastError && !lastError.startsWith(RUN_UNFINALIZED_PREFIX);
}
```

`RUN_INTERRUPTED_ERROR` does **not** start with `RUN_UNFINALIZED_PREFIX`, so
`isRetryableRunFailure` returns `true` and `page.tsx:184-191` renders
`"Generation was interrupted before the invoice was created — use Run Now to retry."` on a run
that is at that moment succeeding. An operator who takes that invitation clicks Run Now, which
reads the already-advanced `nextRunAt`, wins its own CAS, and mints a **second** invoice for the
same customer. That is the exact double-bill the fix's own comment at `:307-315` says the
unfinalized branch exists to prevent — the same hazard, reached through the provisional text
instead. The mobile mirror (`apps/mobile/lib/recurring-invoices-logic.ts:63-75`) shows
"Last run failed" plus the raw detail in the same window, with no retry hint (so it misleads
without inviting the duplicate).

### Repro verdict per test

`apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts`.

| Test                                                                                                    | PRE behavior                                                                                                                                                                              | Verdict                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `:175` **T17** — create failure restores `nextRunAt`, records FAILED, rethrows                          | PRE rethrows (that half passes), but `prisma.recurringInvoice.update` is **never called**, so `toHaveBeenCalledWith(...)` at `:183` fails, as does the `failedWrite` lookup at `:191-194` | **real-repro** — the "wrong value" here is the absence of the persisted outcome and the un-restored schedule, which is B106's own wrong state |
| `:198` **T17b** — post-create failure records billed-but-unfinalized and keeps the advanced `nextRunAt` | PRE has no try/catch around the link at `:217`, so the rejected `prisma.invoice.update` propagates: `resolves.toEqual({id:"inv-1"})` at `:205` fails (it rejects)                         | **real-repro**                                                                                                                                |
| `:221` **T18** — SUCCESS only after create + link                                                       | PRE `calls` = `["claim","create","link"]`; `toEqual([…,"status:SUCCESS"])` fails                                                                                                          | **real-repro**                                                                                                                                |
| `:249` **T19** — the claim stamps a provisional FAILED                                                  | PRE claim `data` = `{nextRunAt, lastRunAt}`; `claimCall.data.lastRunStatus` is `undefined ≠ "FAILED"`                                                                                     | **real-repro**, though it pins an implementation choice of the fix rather than the registered symptom                                         |
| `apps/mobile/__tests__/recurring-invoices-helpers.test.ts:70,:77,:89` **T22a/b/c**                      | `lastRunOutcome` does not exist at PRE → import-time failure, not a value assertion                                                                                                       | **not-a-repro**                                                                                                                               |
| `apps/web/e2e/30-recurring-standing.spec.ts:285` **T33** — the Succeeded pill after Run Now             | deploy-only                                                                                                                                                                               | **no-jest-repro** (T2, spec 30)                                                                                                               |

**Id-level roll-up: `real-repro`** — T17/T17b/T18 all go red on PRE on B106's own wrong state.

Pins: `recurring-invoices.service.spec.ts:178` (T20, a lost claim records no outcome — passes on
both sides) and `:345` (T21, the cron continues past a failing template — passes on both sides;
PRE's per-template `catch` at `:253` already provided this). The happy-path pin at `:181-207` was
**relaxed** — see Harness.

### Residual defects

1. **Provisional-FAILED + retry hint during a healthy run** (detail in Fix verdict (b) above).
   No test covers the in-flight read: every jest test observes only the terminal state.
2. **A crash between claim and create advances the schedule by two cycles.** The claim moves
   `T0 → T1` and stamps FAILED. Recovery is "use Run Now", which advances `T1 → T2` and bills once.
   One invoice is produced where two cycles elapsed, and nothing records the skip. The comment at
   `:212-219` accepts this for the backlog case but the crash case has no note and no test.
3. **`.catch()` swallowing on both outcome writes** (`:269-273`, `:329-333`) is correct in intent
   (do not mask the original error) but means a DB fault at that moment leaves the _provisional_
   FAILED text as the operator's only signal — which is retryable-flagged, and after a real create
   failure the schedule was _not_ restored. That combination (schedule advanced + retryable hint)
   invites the duplicate again.
4. `lastRunAt` is deliberately kept on the failure path (`:261` comment) but the SUCCESS write
   (`:302-305`) is `{lastRunStatus, lastError}` only, so the timestamp shown next to a green
   "Succeeded" pill is the _claim_ time, not the completion time. Cosmetic; asserted as exact by
   T18 `:245`.
5. `RUN_UNFINALIZED_ERROR` is duplicated as a literal in three places — the API constant
   (`recurring-invoices.service.ts:21`), the web `RUN_UNFINALIZED_PREFIX`
   (`apps/web/lib/api/invoices.ts:776`), and the e2e/test string literals. `isRetryableRunFailure`
   is a `startsWith` on that text, so any wording change on the API side silently turns every
   already-billed cycle back into a "retry me" card. No test pins the two constants to each other.
6. Mobile has no `isRetryableRunFailure` equivalent — `lastRunOutcome`
   (`apps/mobile/lib/recurring-invoices-logic.ts:63-75`) returns the same red pill for both
   failure classes. It offers no retry button on that screen, so the exposure is narrower than
   web's, but the two surfaces now disagree about what a FAILED cycle means.

### Fix-shape facts

- The rollback's safety claim in the comment at `:256-261` — "create commits the invoice + its
  ledger rows in ONE tenantTransaction and has no post-commit step on this path (it never passes
  `send`), so a throw means no invoice exists" — is **verified true**:
  `apps/api/src/invoices/invoices.service.ts:475-527` is a single `tenantTransaction` covering the
  invoice, its items and the regulated ledger; the only post-commit branch is `:536-538`
  `if (dto.send)`, and `generateInvoiceFromTemplate` never sets `send`. Restoring `nextRunAt` on a
  create throw therefore cannot mint a duplicate **from that path**. The duplicate risk is entirely
  the concurrency one below.
- `autoSend`'s `sendEmail` (`:282-291`) sits _between_ create and the SUCCESS write, so the
  T17b "billed-but-unfinalized" state can also mean "already emailed to the customer". The comment
  at `:307-309` says so; the UI copy does not.

---

## The B106 race claim (attacked)

**Claim under test** (abandoned remediation plan, `build-plan.md:15`): the failure-rollback at
POST `recurring-invoices.service.ts:240-251` restores `nextRunAt` **unconditionally**, so a
`runNow` or a concurrent tick that moves `nextRunAt` between the failed `create` and the restore
is clobbered back to the pre-claim value; the template fires again next cycle and the customer is
billed an extra time.

### Verdict — `real`

### What was checked

**Writers of `RecurringInvoice.nextRunAt` at POST — the complete set:**

| #   | Site                                   | Form                                                      | Guarded?                                         |
| --- | -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| W1  | `:224-232` the cycle claim             | `updateMany({where:{id, nextRunAt: ri.nextRunAt}, …})`    | **CAS** on `nextRunAt`                           |
| W2  | `:263-268` the create-failure rollback | `update({where:{id}, data:{nextRunAt: ri.nextRunAt, …}})` | **none** — plain update, `where` is the id alone |
| W3  | `:145` `update()` (PATCH)              | `update({where:{id}, data:{… nextRunAt …}})`              | **none**                                         |
| W4  | `:99` `create()`                       | initial value                                             | n/a                                              |

`deactivate()` (`:177-182`) and `activate()` (`:186-191`) do not touch `nextRunAt`.
`runNow` (`:193-200`) has **no** private write path — it reads the row and calls
`generateInvoiceFromTemplate`, i.e. it goes through W1 exactly like the cron. The claim's CAS is
therefore the _only_ mutual exclusion in the whole file, and W2 and W3 both bypass it.

**No outer lock exists.** `generateDueRecurringInvoices` (`:341-380`) has no advisory lock, no
`SELECT … FOR UPDATE`, no idempotency row; the per-tenant loop is a plain `for` over
`findMany({isActive:true, nextRunAt:{lte: now}})`. Contrast
`apps/api/src/common/db-locks.ts`'s `withAdvisoryLock`, which the order-merge paths use — nothing
in this module calls it.

### The interleaving

`ri.nextRunAt = T0` (due). `A` = the midnight cron. `B` = an operator's "Run Now".

| t   | A (cron)                                                                                                              | B (Run Now)                                                    | row `nextRunAt` | row status                    |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------- | ----------------------------- |
| 1   | `findMany` reads `ri` at `T0` (`:355`)                                                                                |                                                                | `T0`            | —                             |
| 2   | W1 CAS `where nextRunAt=T0` → `T1`, `FAILED`/interrupted (`:224-232`), `count=1`                                      |                                                                | `T1`            | FAILED (provisional)          |
| 3   | `invoicesService.create` in flight (`:240`)                                                                           | `findUnique` reads `ri` at `T1` (`:194`)                       | `T1`            | FAILED                        |
| 4   | still in flight                                                                                                       | W1 CAS `where nextRunAt=T1` → `T2` (`:224`), `count=1`         | `T2`            | FAILED                        |
| 5   | still in flight                                                                                                       | `create` succeeds; link + `lastRunStatus:SUCCESS` (`:295-305`) | `T2`            | **SUCCESS**, one real invoice |
| 6   | `create` **throws** → W2 plain `update({where:{id}})` writes `nextRunAt: T0`, `FAILED`, `<create error>` (`:263-268`) |                                                                | **`T0`**        | **FAILED**, retryable         |

State after step 6: `nextRunAt = T0`, which is `<= now`. B's real, committed, customer-facing
invoice is recorded as a **failed** run with a **retryable** error string, and the schedule has
been handed back for a cycle that was already billed. The next midnight tick selects the row
(`:356` `nextRunAt: {lte: now}`), claims it, and generates a **second** invoice — or the operator
does it sooner by taking the "use Run Now to retry" hint the clobbered `lastError` now shows.

**Extra bill: yes.** Two customer invoices where one cycle elapsed and one generation attempt
failed.

### Why the guards do not prevent it

- _"The claim CAS closes the window."_ It closes the **claim** window: two callers cannot claim the
  same `nextRunAt` value. It does nothing for W2, which runs _after_ the claim and carries no
  `where.nextRunAt`. The `where` clause is `{id: ri.id}` plus whatever `forTenant()` adds
  (tenantId) — nothing about the schedule.
- _"B loses its CAS and skips."_ Only if B reads before step 2. If B reads at any point after the
  claim commits — which is the _larger_ part of the window, because A holds the row for the whole
  duration of `invoicesService.create` — B's CAS matches `T1` and succeeds.
- _"Single replica means no concurrency."_ `runNow` is an HTTP endpoint
  (`recurring-invoices.controller.ts` `@Post(":id/run")`) and `generateDueRecurringInvoices` is a
  scheduler callback. They interleave on one Node process at every `await` boundary — no second
  replica is needed. The claim CAS's own existence (added by #373 for exactly `runNow`-races-cron)
  is the codebase's own acknowledgement that these two run concurrently.

### The batch made this reachable in a second, non-concurrent way

W3 (`update():145`) is now driven by **B92's new edit page**, which sends `nextRunAt`
unconditionally on every save (`RecurringInvoiceForm.tsx:309` → `[id]/edit/page.tsx:50-52`). An
operator who saves a schedule change while a generate is in flight and failing has their new date
silently reverted to the pre-claim value by W2 at step 6 — a plain data-loss interleaving with no
duplicate-invoice component and a much wider window than the runNow race (a human clicking Save
while the cron works through a tenant's due list). At PRE this was unreachable: there was no UI
that reached the PATCH (that _is_ B92), and there was no rollback write at all (that _is_ B106).

### What the test set says about it

`REG-B106 T17` (`schedule-outcome.spec.ts:183-190`) asserts the rollback with

```ts
expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
  where: { id: "ri-1" },
  data: expect.objectContaining({ nextRunAt: ri.nextRunAt, lastRunStatus: "FAILED", … }),
});
```

`toHaveBeenCalledWith` on a plain `update` with an exact top-level `{where, data}` shape, and
`where` pinned to `{id: "ri-1"}` with no schedule predicate. The abandoned plan's characterisation
— "REG-B106 T17 asserts the plain form today, so the test encodes the defect" — is **accurate as
of POST**: the assertion is satisfied only by an unguarded write on `recurringInvoice.update`, and
nothing in the file asserts anything about `updateMany` on the rollback path. T17b (`:218`)
additionally asserts `write.data` has no `nextRunAt` key on the _other_ branch, so the two tests
together pin both rollback shapes.

### Confidence and limits

- The interleaving above is derived entirely from POST source; **no test was executed and no
  concurrent scenario was run.** The window's real-world width depends on `invoicesService.create`
  latency and on how often it throws, neither of which was measured here.
- The failure-rate premise is not hypothetical: `invoices.service.ts:530-531` converts `P2002` on
  the invoice number into a `ConflictException`, and the invoice-number allocation is exactly the
  kind of thing that collides under two concurrent generations — i.e. the same concurrency that
  opens the race also supplies the throw that triggers it.

---

## Harness — what a further change to these files would break

Mocks and fixtures with a load-bearing shape. `path:line` at POST unless stated.

### Prisma mock

- `apps/api/src/testing/prisma-mock.ts:49-56` — `modelProxy()` allocates a **fresh** `jest.fn()`
  per method per `createMockPrisma()` call; `:213` builds one `models` object per call. There is
  no module-level cache, so no state leaks between tests or files. (This matters for the T18
  flakiness claim — see below.)
- `prisma-mock.ts:220` — `forTenant()` returns the **same** `models` object as the top level, so
  `prisma.recurringInvoice.update` and `prisma.forTenant().recurringInvoice.update` are the same
  spy. Every assertion in this batch relies on that.
- `prisma-mock.ts:223-229` — `tenantTransaction(fn)` invokes `fn` against a spread of the **same**
  `models`, not a separate tx client. This is what lets
  `order-templates.pricing-and-items.spec.ts:302` assert `prisma.orderTemplateItem.deleteMany` and
  `schedule-outcome.spec.ts:286` assert `prisma.recurringInvoiceItem.deleteMany` even though the
  production code calls `tx.orderTemplateItem` / `tx.recurringInvoiceItem`. If the mock ever gains
  distinct tx models, **T25, T26, T27 and T31 all break at once**.
- `prisma-mock.ts:221` — `getTenantId()` returns the literal `"test-tenant"`, hard-asserted at
  `order-templates.pricing-and-items.spec.ts:308-309` and `schedule-outcome.spec.ts:296`.
- Default `updateMany` returns `{count: 0}` (`prisma-mock.ts:40`), which is a _lost claim_. Every
  generate-path test must set `updateMany.mockResolvedValue({count: 1})` explicitly — done at
  `schedule-outcome.spec.ts:139,162,177,200,224(impl),251` and
  `recurring-invoices.service.spec.ts:102`. A new test that forgets it silently exercises the
  `return null` branch and passes vacuously.

### `OrdersService` test doubles (the stale-mock class)

- `order-templates.pricing-and-items.spec.ts:41` — `realResolver = (OrdersService.prototype as any)
.resolveBuyerLinePrice`, invoked **unbound** at `:49`. Works only because the method body uses no
  `this` (`orders.service.ts:141-213`). Adding any `this.` reference to it breaks this file and
  `order-templates.service.spec.ts` together.
- `order-templates.pricing-and-items.spec.ts:45-50` and
  `order-templates.service.spec.ts:58-64` — both doubles must carry exactly four methods
  (`mergeAllPendingForCustomer`, `loadActivePromotions`, `getCustomerPriceHistory`,
  `resolveBuyerLinePrice`). The second was repaired by this batch (the diff shows it going from
  `{mergeAllPendingForCustomer}` to all four); this is the incident `BUGFIX-NOTES.md` records as
  "ONE stale mock … tripping six lenses and three tests".
- **Two doubles were left un-repaired** and are latent:
  `order-templates.service.spec.ts:186` and `:400` both provide
  `{ provide: OrdersService, useValue: { mergeAllPendingForCustomer: jest.fn() } }`. They pass
  today only because their suites ("template ownership (F2-003)" and "update() with no items key
  (T27)") never reach `createOrderFromTemplate`. Any change that routes an ownership check or
  `update()` through the pricing collaborators fails with
  `ordersService.loadActivePromotions is not a function`.
- `order-templates.pricing-and-items.spec.ts:230-234` (**T14**) asserts
  `resolveBuyerLinePrice` was called with an exact **positional** 7-argument signature
  `(product, 2, [], 24, 2, null, {boxes,pieces,unitsPerBox})`. Any reordering, addition or
  defaulting of that signature — including on the `orders.service.ts` side, which five other call
  sites share (`:1942, :3252, :3554, :3729, :5038`) — breaks this test from a file that does not
  own `orders.service.ts`.

### Assertion shapes that lock the implementation

- `schedule-outcome.spec.ts:183-190` (**T17**) — exact `{where:{id}, data:…}` on
  `recurringInvoice.**update**`. Converting the rollback to a compare-and-set `updateMany`, or
  adding an `include`, fails it. (This is the B106 race lock; see that section.)
- `schedule-outcome.spec.ts:194` — the FAILED write must have **no** `lastRunAt` key.
- `schedule-outcome.spec.ts:218` (**T17b**) — the unfinalized write must have **no** `nextRunAt`
  key.
- `schedule-outcome.spec.ts:243` (**T18**) — `calls` must equal
  `["claim","create","link","status:SUCCESS"]` **exactly**. Wrapping link+status in one
  transaction, moving `autoSend`, or adding any fourth prisma touch on the happy path breaks it.
- `schedule-outcome.spec.ts:245` — the SUCCESS write's `data` must `toEqual`
  `{lastRunStatus:"SUCCESS", lastError:null}` — `toEqual`, not `objectContaining`.
- `schedule-outcome.spec.ts:246` — `updateMany` called exactly once.
- `order-templates.pricing-and-items.spec.ts:307-310` (**T25**) — `updateArg.data.items.create`
  must `toEqual` the exact 4-key objects `{productId, qty, notes, tenantId}`. Adding any field to
  the nested create breaks it.
- `order-templates.pricing-and-items.spec.ts:190-191` (**T12**) — `loadActivePromotions` called
  with the literal `"CUSTOMER"` exactly once.
- `recurring-invoices.service.spec.ts:204-207` — the pre-existing B9 happy-path pin was
  **relaxed** by this batch from
  `expect(prisma.recurringInvoice.update).not.toHaveBeenCalled()` to a filter for writes carrying
  a `nextRunAt` key. The relaxation is reasoned (`:198-202`) and necessary — the SUCCESS write is
  a legitimate second `update` — but the pin no longer catches an _extra, unrelated_
  `recurringInvoice.update` on the happy path. Only T18's `toEqual` on `calls` still does, and
  only for ordering.
- `recurring-invoices.service.spec.ts:178` (**T20**) — a lost claim must call
  `recurringInvoice.update` **zero** times. Any "record that we skipped" write breaks it.

### Fixtures

- `schedule-outcome.spec.ts:19-33` — `template()` is MONTHLY / `dayOfMonth: 15` /
  `nextRunAt: new Date(2026, 6, 15)`. Changing the fixture's `dayOfMonth` breaks the
  `getDate() === 15` assertions at `:150` and `:170`.
- `schedule-outcome.spec.ts:37-41` + `:51` — the `invoices` double is `{create, send, sendEmail}`
  and `prisma.invoice.update` is defaulted to `{id:"inv-1"}` in `beforeEach`, then overridden
  per-test. Adding a fifth `InvoicesService` method to the production path fails every test here.
- `recurring-invoices.service.spec.ts:299-343` (**T21**) — `create` is
  `mockRejectedValueOnce(new Error("boom")).mockResolvedValue({id:"inv-2"})` across **two** due
  templates. It depends on `findMany` returning exactly two rows in order and on `updateMany`
  returning `{count:1}` for both.
- `dto/update-recurring-invoice.dto.spec.ts:9-15` — the dynamic `require` + `try/catch` guard. It
  makes the file survive a missing DTO, but it also means the file **cannot fail on an import
  error**: a DTO that throws at module load degrades to `Dto === undefined`, the pipe skips
  validation, and four of the five tests fail with confusing messages while T29 fails on
  `toBeDefined()`.
- `apps/web/e2e/30-recurring-standing.spec.ts:198-199, 292-296` — `sharedTemplateId` /
  `sharedCustomerName` are module-closure state written by the B92 test (`:242-243`) and read by
  the B106 test (`:296-297`). The dependency is real and documented; it is safe **only** because
  `apps/web/playwright.config.ts:33` sets `fullyParallel: false` (verified). Flipping that global
  to `true`, or splitting these two tests across files, makes T33 fail on the `toBeTruthy()` at
  `:292`. T33 is also the only cleanup for the B92 fixture (`:335-337`), so a T32 failure leaves
  a template row behind — inert (`nextRunAt` in 2099, `:232`) but not deleted.
- `apps/web/playwright.config.ts:420-437` — the `recurring-standing` project entry. Without it the
  whole spec never runs (its own header says so). No jest test guards that config.

### The T18 parallel-worker flakiness claim

The prior evaluation's Finding #5 states `REG-B106 T18` "is not deterministic under parallel jest
workers while passing serially and in isolation (verified by an isolated probe)". **No mechanism
for that is visible in the code**, and two candidate mechanisms were ruled out:

- _Shared mock state._ Ruled out: `createMockPrisma()` (`prisma-mock.ts:11, 49-56, 213`) builds
  every `jest.fn()` fresh per call, and `beforeEach` (`schedule-outcome.spec.ts:36`) calls it per
  test. Jest workers are separate processes, and tests within a file are serial regardless.
- _Non-deterministic ordering inside the function under test._ Ruled out: every step in
  `generateInvoiceFromTemplate` (`recurring-invoices.service.ts:224 → 240 → 295 → 302`) is a
  sequential `await`, with no `Promise.all`, no floating promise, and no timer. `calls` is a
  test-local array. `autoSend` is `false` in the fixture, so the `sendEmail` branch is skipped.

**A far more likely target for the observation is T7** (`schedule-outcome.spec.ts:135-151`), which
is the only test in the file that reads the wall clock (`before = Date.now()` at `:142`,
`claimed.getTime() > before` at `:149`) _and_ depends on today's calendar date — its behavior on
PRE flips at day-of-month 15 (see the B46 repro table). T7b (`:153-171`) shares the clock
dependency. If the probe attributed a red run in this file to the wrong title, T7/T7b are where a
worker-timing or date-boundary effect could actually come from. **Verdict on the T18 claim as
stated: not reproducible by reading; treat as unconfirmed.**

---

## Sibling observations

Same shapes elsewhere in the repo, stated as facts with `path:line` at POST. None of these are in
F13's radius; none were changed by the batch.

### A. Cron-style claim/advance without a compare-and-set

- `apps/api/src/billing/billing-cron.service.ts:284-289` (`rollCycles`, `@Cron("5 0 * * *")`) —
  reads `periodEnd` at `:276-283`, then `update({where:{tenantId}, data:{periodStart: start,
periodEnd: addCycle(start, s.cycle)}})` with **no** `where` predicate on `periodEnd`. This is the
  closest structural twin of B106's W2: a read-then-advance of a scheduling column with last-write
  wins. Two overlapping ticks (or a tick overlapping a subscription mutation) double-advance the
  billing period, which buckets the SCANS/MSGS meters.
- `apps/api/src/billing/billing-cron.service.ts:56-68` (`expireTrials`), `:87-101` (`expireGrace`),
  `:123-134` + `:204` (`applyScheduledDowngrades`), `:218-267` (`applyScheduledCancellations`) —
  all read a due set then plain-`update` each row with no CAS on the field that made it due.
- `apps/api/src/order-templates/order-templates.service.ts:321-330` — the 06:00 standing-order cron
  dedupes with a read (`order.findFirst({templateId, createdAt: {gte: startOfDay}})`) and a
  `continue`, then creates. There is no CAS, no unique constraint on `(templateId, day)`, and no
  advisory lock. Two concurrent ticks, or a tick overlapping a buyer "Reorder"
  (`buyer.controller.ts` POST reorder → same `createOrderFromTemplate`), both see no existing order
  and both create one. This is B106's hazard class in the _other_ F13 file, unguarded, and the
  recurring path is the one that has the CAS.
- `apps/api/src/sales-agents/commission-reconciliation.service.ts:29-69` and
  `apps/api/src/authorizations/authorization-expiry.service.ts:57`,
  `apps/api/src/regulated/regulated-filing-cron.service.ts:62`,
  `apps/api/src/tobacco/tobacco-report.service.ts:320` — same per-tenant `for` + `tenantCtx.run`
  skeleton, no lock. Listed for completeness; not all of them advance a schedule column.
- **No cron in `apps/api/src` calls `withAdvisoryLock`** (`apps/api/src/common/db-locks.ts`), the
  cross-replica lock the order-merge paths use. `grep "@Cron("` returns 13 sites; none of them
  take a lock.

### B. Generate-from-template / document writers that reimplement the price ladder

- `apps/api/src/estimates/estimates.service.ts:71-89` — resolves `CustomerPrice` tier and an
  operator override, then falls to `getTierPrice`/list. It does **not** call
  `resolveBuyerLinePrice`, does **not** load promotions, and does **not** consult the sticky-upsell
  price memory. This is B48's exact shape in a second writer: an estimate quoted for a promo-eligible
  customer prices above what the resulting order will bill, and the estimate→invoice convert path
  carries that number forward.
- `apps/api/src/orders/orders.service.ts:3262-3267` — the non-buyer branch of `updateOrderItems`
  deliberately uses `Number(product.pricePerUnit)` with `STANDARD`/no promo. Documented as
  intentional at `:3246` ("DRIVER edits keep the legacy list price (unchanged)"), so it is a
  _known_ divergence, not a hidden one. Same at `:3492`, `:3708`, `:3866`.
- `apps/api/src/buyer/buyer-catalog.service.ts:205, 385` — the reference implementations that do
  go through the resolver, i.e. the standard the two above depart from.
- `apps/api/src/order-templates/order-templates.service.ts:451` — `categoryTaxAmount: 0` is the one
  line of the template order that still does not mirror `orders.service.create`'s
  per-line category-tax computation (`orders.service.ts:1972` onward).

### C. Controllers whose `@Body()` metatype the ValidationPipe skips

The mapped-type erasure B92 fixed for `recurring-invoices`:

- `apps/api/src/invoices/invoices.controller.ts:156` —
  `@Patch(":id") update(@Param("id") id: string, @Body() dto: Partial<CreateInvoiceDto>)`.
  **Identical defect, still present at POST.** `Partial<>` erases to `Object`, the global pipe
  skips it, and `PATCH /invoices/:id` is unvalidated and unwhitelisted. This is the only other
  `Partial<...Dto>` in a `@Body()` position in the whole API.

Bodies typed `any` / `Record<...>`, which the pipe also skips (a superset of the same class,
listed as facts, not as B92 siblings — several may be deliberate):

- `apps/api/src/customers/customers.controller.ts:216, 228, 306, 312` — advance-payment create,
  advance-payment apply, contact add, contact update. `:216`/`:228` are **money** endpoints with an
  unvalidated body.
- `apps/api/src/estimates/estimates.controller.ts:14` — `@Post() create(@Body() dto: any)`.
- `apps/api/src/inventory/inventory.controller.ts:171, 193, 213` — PO create, PO receive, reorder
  point.
- `apps/api/src/returns/returns.controller.ts:26` — `create(@Body() dto: any, …)`.
- `apps/api/src/system-config/settings.controller.ts:121, 254` and
  `apps/api/src/users/users.controller.ts:57` — `Record<string, unknown>` / `Record<string,string>`
  settings bodies (plausibly deliberate for open key-value settings).

### D. Deploy-window / cross-surface constants

- `RUN_UNFINALIZED_ERROR` (`apps/api/src/recurring-invoices/recurring-invoices.service.ts:21`) and
  `RUN_UNFINALIZED_PREFIX` (`apps/web/lib/api/invoices.ts:776`) are the same English sentence typed
  twice, coupled by a `startsWith` at `:784`. `apps/mobile` mirrors neither. No test asserts the
  two are equal.
- `scripts/data-integrity-report.mjs:424-500` adds three B48/B46 prod checks
  (`template-order-list-price-vs-tier`, a positive control `order-list-price-vs-tier-any`, and a
  `f13-gate-state` closed-gate detector). They are current-basis only — the file's own header note
  at `:40-42` says promotion-based overcharges are unrecoverable — so a clean report is not
  evidence that no B48 overcharge occurred, only that none is _detectable now_.
