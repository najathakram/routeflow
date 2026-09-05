# Build plan: F13 · Recurring invoices and standing orders (B46, B48, B106, B09, B92)

> **Stage S5 — "how".** Authored by Fable 5 on 2026-09-01. Status: `APPROVED`.
> Written AFTER [test-plan.md](./test-plan.md). This file is the ONLY context the
> implementation and review agents receive. Inputs: [discovery.md](./discovery.md) (why),
> [spec.md](./spec.md) (`R#`), [ux-spec.md](./ux-spec.md) (UI), [test-plan.md](./test-plan.md)
> (`T#`). Scale: **major** (money, two Criticals, 5 API files + 7 web files + 3 mobile files).

**Gate to pass before S6:** every work package declares `satisfies:` and `provenBy:`. Met.

**Ground rule — nothing named here is invented.** Every existing path was read on
`master@3d1d8ea9`; files this change CREATES are marked **(NEW)**. The e2e spec number is `30` (allocated by the lead, SEQUENCE.md R6, 2026-09-02; the rest of this sentence is historical) — it was
**proposed and unconfirmed** (28 belongs to F09): the fleet lead confirms it before WP-WEB-E2E
is authored; if a different number is allocated, substitute it in the filename, the
`playwright.config.ts` `testMatch`, the spec header and `workflow-args.json`.

> **Re-verified against master `d4f85fd2` on 2026-09-02 (SEQUENCE.md R5/R6):** `order-templates.service.ts` anchors moved **+8** after `:244` (F14 added `addItemForUser` :244-248): `@Cron` :251→**:259**, `generateDailyOrders` :252→**:260**, `createOrderFromTemplate` :309→**:317**; `update()` :166 unchanged. `orders.service.ts` `loadActivePromotions` :115 and `resolveBuyerLinePrice` :137 are still `private` (WP-ORDERS stands). `order-templates.controller.ts` `@Roles` now admit OPERATOR/CUSTOMER only (F14 removed DRIVER) — the controller stays UNTOUCHED here regardless. E2E spec number **30** (`30-recurring-standing`), lesson id **L-046** (pre-allocated; never take `nextId` for it). F11 is live in rf-F11 and edits `orders.service.ts` in another region (`getOrderTracking`) — keep WP-ORDERS to its two modifier lines so the rebase stays mechanical.

---

## Objective

Make the two recurring engines do what they exist for and make their templates editable: a
MONTHLY recurring invoice fires once per month (B46) and records whether it succeeded, rolling
a failed cycle back so it is retried instead of silently skipped (B106); a standing-order
generated order bills the customer's real tier / override / promotion price through the ONE
shared buyer resolver (B48); the Edit Standing Order modal persists item changes through a
PATCH that now accepts `items` (B09); recurring templates gain an edit page over a PATCH that
now actually validates its body (B92). D4: the integrity report learns the B48 damage
predicate with its positive control and gate state.

**In scope:** the files in the package map. **Out of scope (the fence):** discovery §10 —
mobile edit screens, email-failure surfacing, `categoryTaxAmount` on template lines (record
it for the register as a follow-up: `createOrderFromTemplate` hard-codes 0 while
`orders.service.create` computes it), F14's role narrowing, historical repair _apply_,
customer change on a recurring template, clearing the inactive day field, WEEKLY/BIWEEKLY.

---

## Constraints & conventions

- **Stack:** NestJS 11 + Prisma 7 (`apps/api`), Next.js 14 App Router + TanStack Query +
  `@routeflow/ui/web` (`apps/web`), Expo/RN (`apps/mobile`). Prettier: double quotes,
  semicolons, `printWidth` 100, trailing commas.
- **Worktree:** `C:\ClaudeCode\routeflow\.claude\worktrees\rf-F13` (branch
  `fix/F13-recurring-standing`). It has **no `node_modules` of its own** — it resolves to the
  main checkout's root. `apps/api` and `apps/web` deps are root-hoisted and resolve fine.
  **`apps/mobile` nests dependencies (`expo-router` etc.) that a worktree cannot see**, so
  every mobile command below FAILS with `Cannot find module` until an isolated install has
  been run **inside the worktree**: `npx -y npm@10.8.0 ci` (touches nothing in the shared
  checkout). Run it BEFORE launching S7 if WP-MOBILE/TP-MOBILE stay in the args; otherwise
  Baseline marks the mobile commands broken and excludes them, and the mobile test lands
  `not-run`. `@routeflow/mobile:check-types` under turbo in this worktree is either a cache
  replay or an environmental `expo-router` failure — never chase it.
- **Prisma client:** `apps/api/prisma/schema.prisma` is byte-identical to the main
  checkout's — do NOT run `npx prisma generate` (the generated client is shared at the root
  and regenerating clobbers every other session — L-011).
- **Test runner / layout:** Jest, `*.spec.ts` beside the source in `apps/api/src`, harness
  `apps/api/src/testing/prisma-mock.ts` (`createMockPrisma()`); mobile pure-logic jest in
  `apps/mobile/__tests__/*.test.ts`; Playwright e2e in `apps/web/e2e/NN-*.spec.ts` with a
  `projects[]` entry in `apps/web/playwright.config.ts` — **WITHOUT THAT ENTRY THE SPEC NEVER
  RUNS.** Never run Playwright locally in any form (even `--list` executes reporters and
  clobbers `.campaign/runs/web-e2e.json`); enumerate with `--list --reporter=list` only.
- **Campaign tokens:** every proof `it()` title starts with the exact `REG-B46` / `REG-B48` /
  `REG-B106` / `REG-B09` / `REG-B92` token. Pins carry no token.
- **Existing patterns to copy:** `apps/api/src/orders/orders.service.ts:1708-1770` and
  `:1895-1960` (buyer pricing call shape); `apps/api/src/recurring-invoices/recurring-invoices.service.ts:103-140`
  (item replacement); `apps/api/src/promotions/dto/update-promotion.dto.ts` (`PartialType`);
  `apps/api/src/route-optimization/dto/apply-route-variant.dto.spec.ts` (DTO test harness);
  `apps/web/e2e/27-cancelled-edit-banner.spec.ts` + `24-order-edit-pricing.spec.ts` (e2e
  fixture/cleanup shape); `apps/web/app/(dashboard)/invoices/recurring/new/page.tsx` (the
  form); `.claude/pipeline/design-system.md` (tokens).
- **Must NOT change:** `apps/api/src/order-templates/order-templates.controller.ts` (F14's
  lane); anything in `apps/api/src/routes`; `orders.service.ts` beyond the two access
  modifiers in WP-ORDERS; the WEEKLY/BIWEEKLY branch of `calcNextRunAt`; `schema.prisma`;
  `apps/web/app/buyer/**` (F25's lane); the `@Roles` of any route.
- **Do-not-introduce:** no new dependency (`@nestjs/mapped-types` is already imported by two
  shipped DTOs — resolve-check at Baseline:
  `node -e "console.log(require.resolve('@nestjs/mapped-types',{paths:['apps/api']}))"`),
  no Vitest/Biome, no root config, no second HTTP client, no `fast-check`.
- **Landmines:** nested Prisma creates bypass the tenant proxy — stamp `tenantId` on every
  `items.create[]` row (L-021). `Map.get()` on a CustomerPrice tier may return `null`
  (MSRP-only rows) — always `?? defaultTier`. `computeLineSubtotal` must receive `freeUnits`
  for BOGO lines; never `qty * unitPrice`. `Product.pricePerUnit` etc. are Prisma `Decimal` —
  the resolver already `Number()`s them. The global `ValidationPipe` is
  `whitelist + forbidNonWhitelisted` — a DTO field that is missing is a 400, not ignored.
  Dates: `calcNextRunAt` works in server-local time (UTC on Railway) — keep local-time
  constructors, never `Date.UTC`.

---

## Test packages (authored FIRST — tests only, no source edits)

### TP-API-RI — recurring-invoices specs

- **writes:** `apps/api/src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts` **(NEW)**, `apps/api/src/recurring-invoices/dto/update-recurring-invoice.dto.spec.ts` **(NEW)**, edits `apps/api/src/recurring-invoices/recurring-invoices.service.spec.ts` (existing)
- **tests:** T1, T2, T3, T5, T6, T7, T17, T18, T19, T29, T31 (red set, `REG-B46`/`REG-B106`/`REG-B92` titles) in the two NEW files; pins T4, T8, T20 (extend the existing "returns null … already claimed" test with `expect(prisma.recurringInvoice.update).not.toHaveBeenCalled()`), T21 and T30 (T30 lives in the NEW dto spec but WITHOUT the token) — plus the one-line adjustment at `recurring-invoices.service.spec.ts:198` given verbatim in test-plan §2.2.
- **brief:** copy the provider block of `recurring-invoices.service.spec.ts:150-167` (`createMockPrisma`, `TenantContextService` `{}` or `{ run: jest.fn((_id, fn) => fn()) }` for T21, `InvoicesService` mock). Access the private methods as `(service as any).calcNextRunAt(...)` / `(service as any).generateInvoiceFromTemplate(...)`. Dates: `new Date(2026, 6, 15)` etc.; assert with `getFullYear/getMonth/getDate`. T18's call log: every mock pushes into one `calls: string[]`. T29/T30 guard the import: `const Dto = (() => { try { return require("./update-recurring-invoice.dto").UpdateRecurringInvoiceDto; } catch { return undefined; } })();` and assert `expect(Dto).toBeDefined()` first. Expected values are the hand-derived numbers in test-plan §2 — never read them off the code.
- **must fail with:** assertions listed in test-plan §6 (e.g. `expected 7 received 6`; `toHaveBeenCalledTimes(1) received 0`; `expected Dto toBeDefined`).

### TP-API-OT — order-templates specs

- **writes:** `apps/api/src/order-templates/order-templates.pricing-and-items.spec.ts` **(NEW)**, `apps/api/src/order-templates/dto/update-order-template.dto.spec.ts` **(NEW)**, edits `apps/api/src/order-templates/order-templates.service.spec.ts` (existing — append pins T16, T27)
- **tests:** T9–T15, T23, T25, T26 (red set, `REG-B48`/`REG-B09`); pins T16, T27 (existing file), T24 (NEW dto spec, no token).
- **brief:** harness per test-plan §2.1 — the `OrdersService` mock exposes `mergeAllPendingForCustomer`, `loadActivePromotions`, `getCustomerPriceHistory` as jest mocks and `resolveBuyerLinePrice: jest.fn((...a) => (OrdersService.prototype as any).resolveBuyerLinePrice(...a))` (the REAL resolver — it uses no `this`). `prisma.customer.findUnique` → `{ pricingTier }`, `prisma.customerPrice.findMany` → rows, `prisma.product.findMany` → products WITH tier columns, `SystemConfigService.get` → `"10"`. Read persisted lines from `prisma.order.create.mock.calls[0][0].data.lineItems.create`. T25/T26 use `prisma.tenantTransaction` (the mock runs the callback with the model mocks — assert `deleteMany`/`update` on those same mocks) and a `calls[]` log for order. The DTO spec mirrors `apply-route-variant.dto.spec.ts` with metatype `UpdateOrderTemplateDto` (import normally — the class exists today; only `items` is missing).
- **must fail with:** `expected unitPrice 8 received 10`, `promoFreeUnits 1 received undefined`, `resolveBuyerLinePrice … 0 calls`, `tenantTransaction … 0`, `resolves … received 400`.

### TP-MOBILE — mobile outcome helper spec (severable with WP-MOBILE)

- **writes:** `apps/mobile/__tests__/recurring-invoices-helpers.test.ts` (existing — append `describe("REG-B106 lastRunOutcome", …)`)
- **tests:** T22 (three `it`s, titles starting `REG-B106`)
- **brief:** `import * as logic from "../lib/recurring-invoices-logic"; const fn = (logic as any).lastRunOutcome;` then per case `expect(fn ? fn(input) : undefined).toEqual(expected)` with the three expected values from test-plan T22. Existing tests untouched.
- **must fail with:** `expected {variant:"red", …} received undefined` (each case its own object / `null`).

**Red gate command** (every test in scope fails on an assertion; none may pass):

```bash
cd apps/api && npx jest src/recurring-invoices/recurring-invoices.schedule-outcome.spec.ts src/recurring-invoices/dto/update-recurring-invoice.dto.spec.ts src/order-templates/order-templates.pricing-and-items.spec.ts src/order-templates/dto/update-order-template.dto.spec.ts -t "REG-B" --silent
```

Mobile (only with the isolated install done — otherwise remove from `workflow-args.json`):

```bash
cd apps/mobile && npx jest --config jest.config.js __tests__/recurring-invoices-helpers.test.ts -t "REG-B106" --silent
```

---

## Work packages

### WP-ORDERS — share the buyer pricing resolver (2 modifiers)

- **files:** `apps/api/src/orders/orders.service.ts`
- **satisfies:** R5 (enabler for R5–R9)
- **provenBy:** T9 (compiles and runs through the shared method)
- **dependsOn:** none · **effort:** low
- **brief:** exactly two edits, nothing else in this 5.5k-line file (F11 owns another region of it — keep the diff to these lines). At `:115` change `private async loadActivePromotions(` → `async loadActivePromotions(`; at `:137` change `private resolveBuyerLinePrice(` → `resolveBuyerLinePrice(`. Add one line to each method's existing doc comment: `Shared with OrderTemplatesService (REG-B48): a standing order is priced as the customer's own buyer checkout, whoever triggers it.` Do not move, rename or re-type either method.

### WP-API-RI — recurring invoices: month advance, outcome record + rollback, validated PATCH

- **files:** `apps/api/src/recurring-invoices/recurring-invoices.service.ts`, `apps/api/src/recurring-invoices/recurring-invoices.controller.ts`, `apps/api/src/recurring-invoices/dto/update-recurring-invoice.dto.ts` **(NEW)**
- **satisfies:** R1, R2, R3, R4, R12, R13, R14, R15, R18, R19, R24, R25
- **provenBy:** T1–T8, T17–T21, T29–T31
- **dependsOn:** none
- **brief:** (1) replace the MONTHLY branch of `calcNextRunAt` (put it FIRST, before the "always at least tomorrow" `d` that only WEEKLY/BIWEEKLY use; leave the weekly code byte-identical); (2) rewrite `generateInvoiceFromTemplate` per the code below (claim stamps the provisional outcome; `create` in try/catch with rollback; SUCCESS written last); (3) wrap `update()`'s item replacement in `tenantTransaction`; (4) create the DTO and use it in the controller's PATCH; (5) fix the two wrong comments — `recurring-invoices.controller.ts:50-52` (the PATCH was never validated; it now is, and `isActive` is rejected by the whitelist) — keep the `activate` endpoint as is.
- **exact code:**

```ts
// recurring-invoices.service.ts — module-level, above the class
/** REG-B106: RecurringInvoice.lastRunStatus values (schema comment: "SUCCESS" | "FAILED"). */
export const RUN_STATUS_SUCCESS = "SUCCESS";
export const RUN_STATUS_FAILED = "FAILED";
/** Provisional lastError stamped at claim time; overwritten by SUCCESS or the real failure. */
export const RUN_INTERRUPTED_ERROR = "Generation was interrupted before the invoice was created";
```

```ts
  private calcNextRunAt(
    frequency: RecurringFrequency,
    dayOfWeek?: number | null,
    dayOfMonth?: number | null,
    from: Date = new Date(),
  ): Date {
    if (frequency === RecurringFrequency.MONTHLY) {
      // REG-B46: the old branch called d.setDate(1) BEFORE testing d.getDate() > dom, so
      // the test was always `1 > dom` (false) and the month never advanced — the midnight
      // cron re-selected every MONTHLY template nightly. Decide from `from` itself: the
      // template's dayOfMonth in the earliest month whose occurrence is STRICTLY after
      // `from`'s calendar day, re-applied from `dom` each month and clamped to that
      // month's length (dom 31 → Feb 28 → Mar 31, no drift; Dec → Jan of next year).
      const dom = dayOfMonth ?? 1;
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
    const dow = dayOfWeek ?? 1; // default Monday
    const current = d.getDay();
    const daysUntil = (dow - current + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntil);
    if (frequency === RecurringFrequency.BIWEEKLY) d.setDate(d.getDate() + 7);
    return d;
  }
```

```ts
  private async generateInvoiceFromTemplate(ri: any) {
    // Claim the cycle BEFORE creating anything (B9 — see the history in this comment's
    // previous version). REG-B106: the claim also stamps a PROVISIONAL outcome — until
    // the invoice exists this cycle has NOT succeeded, so a process crash between here
    // and the create below leaves an honest FAILED behind instead of a fresh lastRunAt
    // that reads as success. SUCCESS is written LAST (after the invoice is linked); a
    // create failure overwrites the provisional text with the real error and gives the
    // cycle back (below).
    const nextRunAt = this.calcNextRunAt(ri.frequency, ri.dayOfWeek, ri.dayOfMonth, ri.nextRunAt);
    const claimed = await this.prisma.forTenant().recurringInvoice.updateMany({
      where: { id: ri.id, nextRunAt: ri.nextRunAt },
      data: {
        nextRunAt,
        lastRunAt: new Date(),
        lastRunStatus: RUN_STATUS_FAILED,
        lastError: RUN_INTERRUPTED_ERROR,
      },
    });
    if (claimed.count === 0) {
      this.logger.warn(`Recurring invoice ${ri.id}: cycle already claimed, skipping`);
      return null;
    }

    let invoice: any;
    try {
      invoice = await this.invoicesService.create({
        customerId: ri.customerId,
        discount: Number(ri.discount),
        shippingFee: Number(ri.shippingFee),
        notes: ri.notes,
        terms: ri.terms,
        items: ri.items.map((item: any) => ({
          description: item.description,
          productId: item.productId,
          qty: Number(item.qty),
          unitPrice: Number(item.unitPrice),
          discount: Number(item.discount),
          taxRate: Number(item.taxRate),
        })),
      });
    } catch (err) {
      // REG-B106: record the failure AND give the cycle back. invoicesService.create
      // commits the invoice + its ledger rows in ONE tenantTransaction and has no
      // post-commit step on this path (it never passes `send`), so a throw means no
      // invoice exists — restoring nextRunAt cannot mint a duplicate, and it lets the
      // midnight cron retry tomorrow / "Run now" bill THIS cycle rather than the next.
      // lastRunAt is deliberately kept: it is the time of the attempt.
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.prisma
        .forTenant()
        .recurringInvoice.update({
          where: { id: ri.id },
          data: { nextRunAt: ri.nextRunAt, lastRunStatus: RUN_STATUS_FAILED, lastError: message },
        })
        .catch((e: any) =>
          this.logger.error(
            `Recurring invoice ${ri.id}: generation failed AND the failure could not be recorded (${e?.message ?? e})`,
          ),
        );
      throw err;
    }

    // …autoSend block UNCHANGED…
    // …invoice.update({ recurringInvoiceId }) UNCHANGED…

    // REG-B106: only now — invoice created and linked — is the cycle a success. Never
    // carries nextRunAt (the claim above is the single schedule write on this path).
    await this.prisma.forTenant().recurringInvoice.update({
      where: { id: ri.id },
      data: { lastRunStatus: RUN_STATUS_SUCCESS, lastError: null },
    });

    return invoice;
  }
```

```ts
  async update(id: string, dto: UpdateRecurringInvoiceDto) {
    await this.findOne(id);
    const include = { customer: { select: { id: true, businessName: true } }, items: true };
    const data = {
      ...(dto.frequency && { frequency: dto.frequency }),
      ...(dto.dayOfWeek !== undefined && { dayOfWeek: dto.dayOfWeek }),
      ...(dto.dayOfMonth !== undefined && { dayOfMonth: dto.dayOfMonth }),
      ...(dto.autoSend !== undefined && { autoSend: dto.autoSend }),
      ...(dto.notes !== undefined && { notes: dto.notes }),
      ...(dto.terms !== undefined && { terms: dto.terms }),
      ...(dto.discount !== undefined && { discount: dto.discount }),
      ...(dto.shippingFee !== undefined && { shippingFee: dto.shippingFee }),
      ...(dto.nextRunAt && { nextRunAt: new Date(dto.nextRunAt) }),
    };
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
        data: {
          ...data,
          items: {
            create: items.map((i) => ({
              description: i.description,
              productId: i.productId,
              qty: i.qty,
              unitPrice: i.unitPrice,
              discount: i.discount ?? 0,
              taxRate: i.taxRate ?? 0,
              tenantId, // nested creates bypass forTenant() extension
            })),
          },
        },
        include,
      });
    });
  }
```

```ts
// dto/update-recurring-invoice.dto.ts (NEW)
import { PartialType } from "@nestjs/mapped-types";
import { CreateRecurringInvoiceDto } from "./create-recurring-invoice.dto";

/**
 * REG-B92: the PATCH /recurring-invoices/:id body. Before this class the handler was
 * typed `Partial<CreateRecurringInvoiceDto>` — a mapped type erases to `Object` in
 * design:paramtypes, which the global ValidationPipe skips entirely, so the PATCH body
 * was never validated or whitelisted. Every create field is optional here; nested item
 * validation, ArrayMinSize(1) and the whitelist still apply when `items` is sent.
 * Deliberately no `isActive`: pause/resume are DELETE /:id and POST /:id/activate.
 */
export class UpdateRecurringInvoiceDto extends PartialType(CreateRecurringInvoiceDto) {}
```

```ts
// recurring-invoices.controller.ts — the PATCH handler
  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateRecurringInvoiceDto) {
    return this.recurringInvoicesService.update(id, dto);
  }
```

### WP-API-OT — standing orders: real pricing on generation, `items` on PATCH

- **files:** `apps/api/src/order-templates/order-templates.service.ts`, `apps/api/src/order-templates/dto/update-order-template.dto.ts`, `apps/api/src/order-templates/dto/create-order-template.dto.ts`
- **satisfies:** R5, R6, R7, R8, R9, R10, R11, R20, R21, R23
- **provenBy:** T9–T16, T23–T27
- **dependsOn:** WP-ORDERS
- **brief:** (1) in `create-order-template.dto.ts` add `export` to `class OrderTemplateItemDto` (line 13) so the update DTO reuses it; (2) extend `UpdateOrderTemplateDto` with the optional `items` field below; (3) in `createOrderFromTemplate` replace the pricing block (`:347-372`) with the code below and add `import { UserRole } from "@prisma/client";` (4) replace `update()` (`:166-183`) with the item-replacing version below. Do not touch `generateDailyOrders`, the license guard, `notifySkippedRegulatedLines`, or `mergeAllPendingForCustomer` (the merge now inherits correct prices from the winner because the template order carries them).
- **exact code:**

```ts
// dto/update-order-template.dto.ts — add these imports and the field
import { ArrayMinSize, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { OrderTemplateItemDto } from "./create-order-template.dto";

  /** REG-B09: when present, REPLACES the template's items with this full list (≥ 1). */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderTemplateItemDto)
  items?: OrderTemplateItemDto[];
```

```ts
// order-templates.service.ts — createOrderFromTemplate, replacing lines 347-372
// REG-B48: a standing order is the CUSTOMER's order whoever triggers it (06:00 cron,
// operator "Generate now", buyer "Reorder"), so every line is priced exactly as the
// buyer's own checkout in orders.service.create: per-product CustomerPrice tier >
// customer default tier > list, then the best active CUSTOMER promotion (incl.
// BUY_N_GET_M free units), with the remembered above-list price (sticky upsell)
// honoured — all through the ONE shared resolver. Previously every line billed raw
// product.pricePerUnit.
const customerRecord = await this.prisma.forTenant().customer.findUnique({
  where: { id: template.customerId },
  select: { pricingTier: true },
});
const defaultTier = customerRecord?.pricingTier ?? 1;
const customerPrices = await this.prisma.forTenant().customerPrice.findMany({
  where: { customerId: template.customerId, productId: { in: productIds } },
});
// An MSRP-only CustomerPrice row has pricingTier null — `??` below falls through it.
const cpTier = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));
const activePromos = await this.ordersService.loadActivePromotions(UserRole.CUSTOMER);
const priceHistory = await this.ordersService.getCustomerPriceHistory(template.customerId);

const tenantId = this.prisma.getTenantId();
let subtotal = 0;
const lineItemsData = allowedItems.map((item) => {
  const product = productMap.get(item.productId);
  if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
  const tierForProduct = cpTier.get(item.productId) ?? defaultTier;
  // A template qty is a SELLING-UNIT count (a box for boxed products) and is never
  // split into boxes/pieces here — the same "box-unaware boxed line" the interactive
  // path handles: unitPrice is the box price, qty bills as whole units, and the promo
  // context sees the true piece count so QTY_BREAK thresholds are measured in pieces.
  const upb = Number(product.unitsPerBox ?? 0);
  const qtyUnits = item.qty;
  const qtyPieces = upb > 1 ? item.qty * upb : item.qty;
  const resolved = this.ordersService.resolveBuyerLinePrice(
    product,
    tierForProduct,
    activePromos,
    qtyPieces,
    qtyUnits,
    priceHistory[item.productId]?.lastPrice ?? null,
    { boxes: null, pieces: null, unitsPerBox: upb },
  );
  // BUY_N_GET_M subtracts whole free selling units BEFORE pricing (exact, never a
  // rounded net unit price); every other line reduces to unitPrice × qty, rounded.
  const itemSubtotal = computeLineSubtotal({
    unitPrice: resolved.unitPrice,
    qty: item.qty,
    freeUnits: resolved.freeUnits,
  });
  subtotal = roundMoney(subtotal + itemSubtotal);
  return {
    productId: item.productId,
    qty: item.qty,
    unitPrice: resolved.unitPrice,
    priceType: resolved.priceType,
    originalPrice: resolved.originalPrice,
    promoFreeUnits: resolved.freeUnits > 0 ? resolved.freeUnits : null,
    subtotal: itemSubtotal,
    notes: item.notes ?? undefined,
    // W4/W6b: snapshot the product's regulated category at sale time (unchanged).
    trackedCategoryId: product.trackedCategoryId ?? null,
    categoryTaxAmount: 0,
    tenantId, // nested creates bypass forTenant() extension
  };
});
```

```ts
// order-templates.service.ts — update(), replacing lines 166-183
  async update(id: string, dto: UpdateOrderTemplateDto) {
    await this.findOne(id);
    const include = {
      items: { include: { product: { select: { id: true, name: true, unit: true } } } },
      customer: { select: { id: true, businessName: true } },
    };
    const scalar = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.daysOfWeek !== undefined ? { daysOfWeek: dto.daysOfWeek } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };
    if (dto.items === undefined) {
      return this.prisma.forTenant().orderTemplate.update({ where: { id }, data: scalar, include });
    }
    // REG-B09: an edit that carries `items` REPLACES the template's items — the web modal
    // sends the full list it displays, so what the operator sees is what saves. Every
    // productId must exist in this tenant (mirrors create()) BEFORE any write, and the
    // delete + re-create run in ONE transaction so a failure can never leave a template
    // with no items.
    const items = dto.items;
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await this.prisma
      .forTenant()
      .product.findMany({ where: { id: { in: productIds } }, select: { id: true } });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products not found");
    }
    const tenantId = this.prisma.getTenantId();
    return this.prisma.tenantTransaction(async (tx) => {
      await tx.orderTemplateItem.deleteMany({ where: { templateId: id } });
      return tx.orderTemplate.update({
        where: { id },
        data: {
          ...scalar,
          items: {
            create: items.map((item) => ({
              productId: item.productId,
              qty: item.qty,
              notes: item.notes,
              tenantId, // nested creates bypass forTenant() extension
            })),
          },
        },
        include,
      });
    });
  }
```

### WP-WEB-RECURRING — outcome pill + Edit on the card; the edit route over a shared form

- **files:** `apps/web/lib/api/invoices.ts`, `apps/web/app/(dashboard)/invoices/recurring/page.tsx`, `apps/web/app/(dashboard)/invoices/recurring/new/page.tsx`, `apps/web/app/(dashboard)/invoices/recurring/_components/RecurringInvoiceForm.tsx` **(NEW)**, `apps/web/app/(dashboard)/invoices/recurring/[id]/edit/page.tsx` **(NEW)**
- **satisfies:** R16, R26, R27, R28
- **provenBy:** T32, T33 (post-deploy e2e)
- **dependsOn:** none
- **brief:** (1) `invoices.ts`: add `lastRunStatus?: "SUCCESS" | "FAILED" | null; lastError?: string | null;` to `RecurringInvoice` (after `lastRunAt`), and fix the comment at `:835-837` (the PATCH was unvalidated, not validated-against-create; `isActive` is now rejected by the whitelist — the activate endpoint stays the resume path). (2) `page.tsx`: import `Pencil` from `lucide-react`; render the outcome per ux-spec (pill after the date inside the existing `Last run` row; the danger line under the dates block when FAILED; both using the in-file pill classes); add the Edit button between Run Now and the pause toggle exactly as in ux-spec. (3) Extract EVERYTHING inside `NewRecurringInvoicePage` except `router`/`setTitle`/`createRecurring`/`handleSubmit`'s mutate call into `RecurringInvoiceForm` (move `CustomerSearch`, `ProductSearchInput`, `LineItemState`, `createEmptyItem`, the state hooks, `validate`, the JSX grid) with the prop contract below; `new/page.tsx` becomes: title effect + `<RecurringInvoiceForm mode="create" isPending={createRecurring.isPending} submitLabel="Create Template" onSubmit={(dto) => createRecurring.mutate(dto, {…existing onSuccess/onError…})} />` under the existing back link + `<h2>`. (4) The edit page per ux-spec (loading spinner, error card, prefill, strip `customerId`, `useUpdateRecurringInvoice`, toasts, `router.push("/invoices/recurring")`).
- **exact code (form contract + edit page):**

```tsx
// _components/RecurringInvoiceForm.tsx (NEW) — exported contract
export interface RecurringInvoiceFormProps {
  mode: "create" | "edit";
  /** edit: the loaded template; seeds every field once (keyed on initial?.id). */
  initial?: RecurringInvoice;
  onSubmit: (dto: CreateRecurringInvoiceDto) => void;
  isPending: boolean;
  submitLabel: string;
}
// In edit mode: the Customer card renders
//   <div className="rounded-lg border border-surface-border px-3 py-2.5">
//     <p className="text-sm font-semibold text-navy">{initial.customer?.businessName ?? initial.customerId}</p>
//     <p className="text-xs text-navy/70">Customer can't be changed on an existing template.</p>
//   </div>
// instead of <CustomerSearch>, validate() skips the customer rule, the date label reads
// "Next Run Date", and the submitted dto uses customerId: initial.customerId.
// Prefill (edit): frequency; dayOfWeek ?? 1; dayOfMonth ?? 1; autoSend; nextRunAt.slice(0,10);
// notes ?? ""; terms ?? ""; String(discount ?? 0); String(shippingFee ?? 0); items → rows
// { key: String(i), productId, description, qty: Number(qty), unitPrice: Number(unitPrice),
//   taxRate: Number(taxRate ?? 0), discount: Number(discount ?? 0) }.
```

```tsx
// [id]/edit/page.tsx (NEW)
"use client";
import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button, Card, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useRecurringInvoice, useUpdateRecurringInvoice } from "@/lib/api/invoices";
import { RecurringInvoiceForm } from "../../_components/RecurringInvoiceForm";

export default function EditRecurringInvoicePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { data: template, isLoading, isError } = useRecurringInvoice(params.id);
  const updateRecurring = useUpdateRecurringInvoice();

  React.useEffect(() => {
    setTitle("Edit Recurring Template");
  }, [setTitle]);

  return (
    <div className="space-y-5 p-6">
      <Link
        href="/invoices/recurring"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Recurring Invoices
      </Link>
      <h2 className="text-2xl font-bold text-navy">Edit Recurring Template</h2>
      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
        </div>
      ) : isError || !template ? (
        <Card>
          <p className="text-sm text-navy">This recurring template could not be loaded.</p>
          <Button className="mt-3" variant="secondary" href="/invoices/recurring">
            Back to Recurring Invoices
          </Button>
        </Card>
      ) : (
        <RecurringInvoiceForm
          mode="edit"
          initial={template}
          isPending={updateRecurring.isPending}
          submitLabel="Save Changes"
          onSubmit={({ customerId: _customerId, ...dto }) =>
            updateRecurring.mutate(
              { id: template.id, ...dto },
              {
                onSuccess: () => {
                  toast({ title: "Recurring template updated", variant: "success" });
                  router.push("/invoices/recurring");
                },
                onError: (err: any) =>
                  toast({
                    title: "Failed to update template",
                    description: err?.response?.data?.message ?? "Please try again.",
                    variant: "error",
                  }),
              },
            )
          }
        />
      )}
    </div>
  );
}
```

### WP-WEB-STANDING — the Edit Standing Order modal saves its items

- **files:** `apps/web/lib/api/order-templates.ts`, `apps/web/app/(dashboard)/customers/[id]/StandingOrderModal.tsx`
- **satisfies:** R22
- **provenBy:** T28 (post-deploy e2e)
- **dependsOn:** none
- **brief:** in `order-templates.ts` extend `useUpdateOrderTemplate`'s variables type with `items?: { productId: string; qty: number; notes?: string }[]`. In the modal: `LineItem` gains `notes?: string`; the prefill (`:95-103`) copies `notes: item.notes`; `addLineItem` leaves it undefined; the edit branch of `handleSubmit` sends `items` and the stale comment at `:180` is replaced. No JSX change.
- **exact code:**

```ts
if (isEditing && template) {
  // REG-B09: the modal shows the full item list in edit mode, so it saves the full
  // list — adds, removes and qty changes included (PATCH replaces items). Item notes
  // are not editable here and are carried through unchanged.
  updateTemplate.mutate(
    {
      id: template.id,
      name: name.trim(),
      daysOfWeek: selectedDays,
      notes: notes.trim() || undefined,
      items: lineItems.map((li) => ({ productId: li.productId, qty: li.qty, notes: li.notes })),
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

### WP-WEB-E2E — deployed-only Playwright spec (number pending) + its config entry

- **files:** `apps/web/e2e/30-recurring-standing.spec.ts` **(NEW — `30` ALLOCATED by the lead (SEQUENCE.md R6, 2026-09-02))**, `apps/web/playwright.config.ts`
- **satisfies:** the T2 proofs of R16, R22, R26, R27 (deliverable — proves post-deploy)
- **provenBy:** T28, T32, T33
- **dependsOn:** none
- **brief:** author the three tests exactly per test-plan §2 (T28, T32, T33) in the shape of `27-cancelled-edit-banner.spec.ts` (header doc block explaining T2/proven-pending-deploy, `BASE`, `apiHeaders`, hydration entry wait via `/orders` + `New Order`, `setTenantCookie` in `beforeEach`, `apiBase`/`operatorAccessToken`, `expect(res.ok(), …).toBe(true)` hard failures, `finally` cleanup). Fixture payloads per test-plan §7 (spec-24 precedent). Titles: `REG-B09 …`, `REG-B92 …`, `REG-B106 web leg — …` (the T1 jest is B106's tier proof; this is the rendered SUCCESS surface). Append the `projects[]` entry below after the `cancelled-edit-banner` entry. **Never run it** (no `npx playwright test`, not even `--list` without `--reporter=list`); it is typechecked by `cd apps/web && npx tsc --noEmit`.
- **exact code (config entry):**

```ts
    // ── Recurring-template edit + standing-order item edit (F13, spec 30) ──────
    // REG-B92: /invoices/recurring/[id]/edit exists and persists a schedule/notes
    // change; every list card links to it. REG-B09: the Edit Standing Order modal
    // persists item adds and qty changes through PATCH `items`. REG-B106 web leg:
    // after Run Now the card shows the recorded "Succeeded" outcome (the API write
    // is jest-proven in apps/api). Mutating but self-contained: throwaway
    // `E2E B09 …` / `E2E B92 …` fixtures on the approved seed tenant; the recurring
    // template is created with nextRunAt in 2099 and deactivated in a `finally` so a
    // leaked row can never fire the midnight cron, and the Run Now invoice is voided
    // there too. NOT part of F13's red gate — runs only against the DEPLOYED site and
    // is expected red until F13 ships.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's header.
    {
      name: "recurring-standing",
      testMatch: /30-recurring-standing\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
    },
```

### WP-MOBILE — outcome on the mobile recurring detail (severable; needs the isolated install)

- **files:** `apps/mobile/lib/api/recurring-invoices.ts`, `apps/mobile/lib/recurring-invoices-logic.ts`, `apps/mobile/app/(operator)/recurring-invoices/[id].tsx`
- **satisfies:** R17
- **provenBy:** T22
- **dependsOn:** none
- **brief:** add `lastRunStatus?: "SUCCESS" | "FAILED" | null; lastError?: string | null;` to the mobile `RecurringInvoice` interface (after `lastRunAt`); add the helper below to the logic module; in `[id].tsx` compute `const outcome = lastRunOutcome(template);` next to the existing `s`/`flags` and render under the dates `Text` (`:121-125`): `{outcome ? (<View style={{ marginTop: 6, gap: 4 }}><Pill variant={outcome.variant} dot>{outcome.label}</Pill>{outcome.detail ? <Text style={styles.dates}>{outcome.detail}</Text> : null}</View>) : null}`. Import `lastRunOutcome` beside the existing logic imports. Nothing else on the screen changes; no `isWeb`/`Platform` branch is touched (L-025 n/a).
- **exact code:**

```ts
export type LastRunStatus = "SUCCESS" | "FAILED";
export interface LastRunOutcome {
  variant: PillVariant;
  label: string;
  /** The recorded error, FAILED only. */
  detail?: string;
}

/**
 * REG-B106 (mobile mirror of the web list card): the outcome of the last cron / run-now
 * cycle. null when there is nothing honest to show — no run yet, or a legacy row that ran
 * before outcomes were recorded (status null): the date alone is shown and no claim of
 * success is made.
 */
export function lastRunOutcome(t: {
  lastRunAt?: string | null;
  lastRunStatus?: LastRunStatus | null;
  lastError?: string | null;
}): LastRunOutcome | null {
  if (!t.lastRunAt || !t.lastRunStatus) return null;
  if (t.lastRunStatus === "FAILED") {
    return { variant: "red", label: "Last run failed", detail: t.lastError ?? undefined };
  }
  return { variant: "green", label: "Last run succeeded" };
}
```

### WP-D4 — integrity-report checks for B48 (predicate, positive control, gate state)

- **files:** `scripts/data-integrity-report.mjs`
- **satisfies:** R29
- **provenBy:** T34 (`node --check` + lens review of the SQL against `apps/api/prisma/schema.prisma`)
- **dependsOn:** none · **effort:** low
- **brief:** insert the three entries below into `CHECKS` immediately after the `recurring-stalled` entry (`:412-421`). Keep the file's conventions: `${t}` tenant clause with alias `x.` replaced to the outer alias; select ids/amounts only (never names/emails). Add one line to the header's VALIDATION STATUS block: `• B48 (F13): template-order-list-price-vs-tier is CURRENT-basis (tier/override as of now; promotion-based overcharges are unrecoverable) — read it beside order-list-price-vs-tier-any (positive control) and f13-gate-state (rows = closed gates).`
- **exact code:**

```js
  // ── Standing-order pricing (B48, F13) ───────────────────────────────────────
  {
    name: "template-order-list-price-vs-tier",
    severity: "high",
    explain:
      "template-generated line billed at the CURRENT list price while the customer's CURRENT tier/override price differs (B48 overcharge candidates — current-basis; promotions unrecoverable)",
    sql: (t) => `
      SELECT li.id, o.id AS order_id, o.status::text AS order_status,
             li."unitPrice"::float8 AS billed, tp.tier_price::float8 AS tier_price,
             (li."unitPrice" - tp.tier_price)::float8 AS delta_per_unit, li.qty::float8 AS qty
      FROM "OrderItem" li
      JOIN "Order" o ON o.id = li."orderId"
      JOIN "Product" p ON p.id = li."productId"
      JOIN "Customer" c ON c.id = o."customerId"
      LEFT JOIN "CustomerPrice" cp ON cp."customerId" = c.id AND cp."productId" = p.id
      CROSS JOIN LATERAL (
        SELECT CASE COALESCE(cp."pricingTier", c."pricingTier", 1)
                 WHEN 2 THEN p."priceTier2" WHEN 3 THEN p."priceTier3"
                 WHEN 4 THEN p."priceTier4" WHEN 5 THEN p."priceTier5"
                 ELSE p."pricePerUnit" END AS tier_price
      ) tp
      WHERE o."templateId" IS NOT NULL
        AND li.status <> 'CANCELLED'
        AND li."priceType" = 'STANDARD'
        AND abs(li."unitPrice" - p."pricePerUnit") <= 0.005
        AND tp.tier_price > 0
        AND abs(li."unitPrice" - tp.tier_price) > 0.005 ${t.replace(/x\./g, "o.")}`,
  },
  {
    name: "order-list-price-vs-tier-any",
    severity: "info",
    explain:
      "POSITIVE CONTROL for the check above: the same arithmetic over ALL orders — expected > 0 on any tenant with tiered customers; if this is ALSO 0, distrust the predicate, not the data",
    sql: (t) => `
      SELECT li.id, o.id AS order_id, li."unitPrice"::float8 AS billed, tp.tier_price::float8 AS tier_price
      FROM "OrderItem" li
      JOIN "Order" o ON o.id = li."orderId"
      JOIN "Product" p ON p.id = li."productId"
      JOIN "Customer" c ON c.id = o."customerId"
      LEFT JOIN "CustomerPrice" cp ON cp."customerId" = c.id AND cp."productId" = p.id
      CROSS JOIN LATERAL (
        SELECT CASE COALESCE(cp."pricingTier", c."pricingTier", 1)
                 WHEN 2 THEN p."priceTier2" WHEN 3 THEN p."priceTier3"
                 WHEN 4 THEN p."priceTier4" WHEN 5 THEN p."priceTier5"
                 ELSE p."pricePerUnit" END AS tier_price
      ) tp
      WHERE li.status <> 'CANCELLED'
        AND li."priceType" = 'STANDARD'
        AND abs(li."unitPrice" - p."pricePerUnit") <= 0.005
        AND tp.tier_price > 0
        AND abs(li."unitPrice" - tp.tier_price) > 0.005 ${t.replace(/x\./g, "o.")}`,
  },
  {
    name: "f13-gate-state",
    severity: "info",
    explain:
      "each row is a CLOSED gate for the B46/B48 checks (recurring-duplicate-fire, template-order-list-price-vs-tier): a 0-row result on those is only evidence of no damage while THIS returns 0 rows",
    sql: (t) => `
      SELECT g.id, g.n
      FROM (
        SELECT 'monthly-templates-ever-run' AS id,
               (SELECT count(*) FROM "RecurringInvoice" x
                 WHERE x.frequency = 'MONTHLY' AND x."lastRunAt" IS NOT NULL ${t})::int AS n
        UNION ALL
        SELECT 'template-generated-orders',
               (SELECT count(*) FROM "Order" x WHERE x."templateId" IS NOT NULL ${t})::int
        UNION ALL
        SELECT 'template-orders-for-tiered-or-override-customers',
               (SELECT count(*) FROM "Order" x
                 JOIN "Customer" c ON c.id = x."customerId"
                 WHERE x."templateId" IS NOT NULL ${t}
                   AND (c."pricingTier" <> 1 OR EXISTS (
                     SELECT 1 FROM "CustomerPrice" cp
                     WHERE cp."customerId" = c.id AND cp."pricingTier" IS NOT NULL)))::int
      ) g
      WHERE g.n = 0`,
  },
```

### Package map

| WP               | satisfies                          | provenBy                | dependsOn | Wave |
| ---------------- | ---------------------------------- | ----------------------- | --------- | ---- |
| WP-ORDERS        | R5 (enabler)                       | T9                      | —         | 1    |
| WP-API-RI        | R1–R4, R12–R15, R18, R19, R24, R25 | T1–T8, T17–T21, T29–T31 | —         | 1    |
| WP-WEB-RECURRING | R16, R26, R27, R28                 | T32, T33                | —         | 1    |
| WP-WEB-STANDING  | R22                                | T28                     | —         | 1    |
| WP-WEB-E2E       | proofs of R16/R22/R26/R27          | T28, T32, T33           | —         | 1    |
| WP-MOBILE        | R17                                | T22                     | —         | 1    |
| WP-D4            | R29                                | T34                     | —         | 1    |
| WP-API-OT        | R5–R11, R20, R21, R23              | T9–T16, T23–T27         | WP-ORDERS | 2    |

Cross-check: every R1–R29 appears in a `satisfies:` (R28 via WP-WEB-RECURRING; R11 via
WP-API-OT's DTO shape); every T1–T34 appears in a `provenBy:` (T34 = command). File lists are
disjoint across all packages; test packages touch only spec/test files.

**Engine config decisions:** `redGate` = the api command in the Test packages section (+ the
mobile one only with the install done); no `uiVerify` (deployed-only e2e, local Playwright
forbidden); `mutationProbe.targets` = test-plan §9's eight targets (every one on a HIGH-risk
money/billing file); `dependsOn` only WP-API-OT → WP-ORDERS. The orchestrating session still
honours the house cap of four background agents (L-005).

---

## Acceptance criteria

1. `R1/R2` — `calcNextRunAt("MONTHLY", null, 15, 2026-07-15)` → 2026-08-15; a 12-cycle chain advances one month each with no day drift; dom 31 clamps per month.
2. `R3` — WEEKLY/BIWEEKLY results are byte-identical (T8 green before and after).
3. `R4` — the claim's `data.nextRunAt` is strictly in the future.
4. `R5–R9` — a tier-2 customer's 2-unit template line persists `{unitPrice 8, SPECIAL, originalPrice 10, subtotal 16}` from a $10/$8 product; a 10 % promo → 9.00 PROMO; BOGO 2+1 on qty 3 → `promoFreeUnits 1`, subtotal 20; boxed 12/box tier-2 $20 × 2 → resolver called with `(…, 24, 2, null, {null,null,12})`, subtotal 40; a remembered $12 → MANUAL 12 / list 10.
5. `R10` — tier 1 with nothing else → 10 / STANDARD / null (unchanged).
6. `R12` — a throwing `create` records FAILED + message, restores `nextRunAt`, keeps `lastRunAt`, rethrows.
7. `R13/R14/R15` — SUCCESS/null is written after the link; the claim carries the provisional FAILED; `lastError` non-null iff FAILED.
8. `R16/R27` — the list card shows Succeeded/Failed pills and an Edit button to `/invoices/recurring/<id>/edit`.
9. `R20/R21/R23` — PATCH `items` validated (≥1, int qty ≥1, no `unitPrice`), products checked before any write, replace-all in one `tenantTransaction` with `tenantId`; a PATCH without `items` writes no items.
10. `R22` — the modal's edit branch sends `items` (adds/removes/qty), carrying `notes`.
11. `R24/R25` — `UpdateRecurringInvoiceDto` accepts `{notes}` alone, rejects `{isActive:true}`, validates nested items; recurring item replacement is transactional.
12. `R26/R28` — the edit route loads, pre-fills, saves via PATCH, toasts, returns to the list; create and edit render ONE form component.
13. `R29` — `node --check scripts/data-integrity-report.mjs` passes and the three checks are registered with the stated names.
14. Negative: `order-templates.controller.ts`, `apps/api/src/routes/**`, `schema.prisma`, `apps/web/app/buyer/**` are untouched; `orders.service.ts` diff is exactly the two modifiers (+ comment lines).
15. Deploy day: rows with `lastRunStatus null` render date-only; no migration; no `prisma generate`.

---

## Verification commands

Every command exists today and passes on the untouched worktree (api/web); the mobile pair
passes only after the isolated install. **One `cd … && …` chain per entry** (each entry is
its own shell; never split the `cd` out, never use `;`). Pass `workflow-args.json` to the
Workflow tool as a real object — a JSON _string_ gets entity-escaped and breaks `&&`.

Per round:

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/web && npx tsc --noEmit
```

Final:

```bash
cd apps/api && npx jest src/recurring-invoices src/order-templates --silent
cd apps/api && npx eslint src/recurring-invoices src/order-templates src/orders/orders.service.ts
cd apps/web && npm run lint
node --check scripts/data-integrity-report.mjs
cd apps/mobile && npx jest --config jest.config.js __tests__/recurring-invoices-helpers.test.ts --silent
cd apps/mobile && npx tsc --noEmit
```

Deliberately NOT here (repo-wide gates belong to the human close-out — S5 rule 5): `npm run
verify`, `npm run validate-lessons`, `node scripts/campaign-check.mjs`, any Playwright command.

---

## Post-pipeline human close-out (NOT agent work)

1. Read the run's own result: `redGate.properlyRed`, `mutationProbe.allCaught/restoredVerified/
skippedTargets`, `finalPass.completed`, `remainingFindings`. Write `RESUME.md` beside this
   file the moment the Workflow tool result returns (runId, scriptPath, the exact args).
2. Commit → in the worktree run `npm run verify` (repo-wide; regenerates
   `.campaign/runs/api.json` — check its **mtime** post-dates the change, L-034) → `node
scripts/campaign-check.mjs --batch F13 --pipeline-dir .claude/pipeline/2026-09-01-F13-recurring-standing`.
   `@routeflow/mobile:check-types` in a worktree is a cache replay or an environmental
   `expo-router` failure — not a defect.
3. **Lessons entry (Gate 3):** write it normally. Master now runs `npm run validate-lessons`
   as verify step 2 (#593) and the register sits at **24.9/25.0 KB** — the new entry WILL trip
   the size cap. That is expected: **never trim the entry to fit and never archive entries to
   make room**; the PR holds at that gate until the owner's one-field `maxBytes` ruling lands.
   Candidate lesson: "a `Partial<Dto>` handler type is an unvalidated endpoint — mapped types
   erase to `Object` and the ValidationPipe skips them; the compiled `design:paramtypes` is the
   check" (B92) and/or "a claim-first idempotency guard needs a stated rollback rule per write
   — decide from whether the guarded operation is atomic" (B106, L-037 family).
4. Ledger flips in `.claude/campaign/status/F13.jsonl`: B46, B48, B106 → `proven` (T1) with
   proof text naming the REG tests and mutation probes; B09, B92 → `proven-pending-deploy`
   (T2) naming spec `30` (allocated, R6) and its config entry; add
   `buildPlan: ".claude/pipeline/2026-09-01-F13-recurring-standing/build-plan.md"` to each row.
   Register citation note for B09/B46/B48/B92: `OUT_OF_BOUNDS` was a parser artifact — files
   unchanged in length between `6c8f1401` and `3d1d8ea9`, citations verified in-bounds.
5. Code map: `.claude/code-map/api.md` entries for `recurring-invoices/` (calcNextRunAt fix,
   outcome columns wired, rollback rule, `UpdateRecurringInvoiceDto`), `order-templates/`
   (buyer resolver, `items` on PATCH), `orders/` (two methods now public, shared);
   `.claude/code-map/web.md` (`invoices/recurring/[id]/edit`, `_components/RecurringInvoiceForm.tsx`,
   card outcome + Edit, `StandingOrderModal` sends items); `mobile.md` (`lastRunOutcome`).
   Bump `_meta.json`. Register follow-ups to file: template lines carry `categoryTaxAmount 0`
   (regulated category tax not applied on standing orders); mobile has no recurring-template
   edit screen; stale-day-field on frequency switch.
6. PR (one PR, title names every layer: `fix(recurring,order-templates,web,mobile)`), merge
   per the canonical flow (public → CI → merge → wait for `BUILDING` → private), post-deploy
   check (`SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app npm run post-deploy-check`),
   the `deployment_status` e2e run discharges B09/B92 (never dispatch it).
7. **D4 (read-only on prod):** `railway run --service postgres node scripts/data-integrity-report.mjs --verbose`.
   Read three things together: `f13-gate-state` must return **0 rows** (all gates open) and
   `order-list-price-vs-tier-any` must return **> 0** (the predicate demonstrably fires) before
   a 0 on `template-order-list-price-vs-tier` may be recorded as "no identifiable damage".
   `recurring-duplicate-fire` lists B46's duplicate invoices (including the one extra deploy-
   night run per due MONTHLY template). Save the JSONL/printout to `local-assets/` (never
   `docs/`). **Repair is an OWNER decision**: voiding SENT/PAID duplicates and re-pricing
   delivered/invoiced template orders are money operations; promotion-based overcharges are
   unidentifiable in hindsight and are recorded as unrepairable, never guessed.
8. Board #526 → done after the e2e discharge.
