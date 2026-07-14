# P6-5 — Transactional trigger wiring (domain event → messaging engine) — API only

## Status

PLANNED — 2026-07-14

## Context

- **P6-2 engine + P6-6 matrix/seeding SHIPPED.** `MessagingService.notify(eventKey, {customerId, senderId, vars?})` (`messaging.service.ts:184`) reads enabled NotificationRules, renders each channel's active template, sends, records a Message, **meters WA/SMS once** (:171). No-ops when no rule enabled. **Triggers must NOT meter.** `EVENT_CHANNELS`/`DEFAULT_TEMPLATES` (`messaging-config.service.ts`) define each event's vars.
- **`Message.senderId` is a REQUIRED FK to User** (schema:2372). In-request triggers use `user.sub`. Cron/no-user sites have none → a `resolveSystemSenderId(tenantId)` resolver (oldest ACTIVE TENANT_ADMIN, else oldest ACTIVE OPERATOR — there is NO `Tenant.ownerId`, verified). No resolvable sender → SKIP, never crash.
- **After-commit, fire-and-forget:** every trigger runs AFTER the status write commits, NEVER inside a `tenantTransaction` (tx mock lacks messaging models; dispatch mustn't block a Serializable tx). `.catch(() => {})` on a promise that never rejects.
- **Money/date vars are PRE-FORMATTED STRINGS.** No shared API formatter exists → WP1 adds `formatMoney` (Intl en-US USD, per email.service.ts:220) + `formatDate` (invoice-email long style) to `messaging.helpers.ts`. **Format the STORED `order.total`/`invoice.total` — NEVER recompute.**
- **OUT_FOR_DELIVERY is `changeStatus`-only** (verified — nothing in routes sets that order status; dispatch only assigns stops). So it's covered in WP2; NO routes-side OUT_FOR_DELIVERY wiring. Routes DOES need DELIVERED (completeStop/completeWithPayment flip orders inside a tx, bypassing changeStatus).
- **NO migration.** **Deferred (single item): PAYMENT_REMINDER** — needs a daily cron + a per-invoice marker migration (`Invoice.lastReminderOn`), out of this increment's scope.

## Acceptance

Order flips (CONFIRMED/OUT_FOR_DELIVERY/DELIVERED via changeStatus), driver stop completion (DELIVERED), invoice issue (send/sendEmail DRAFT→SENT, once), change-request-at-door creation, and the license-expiry cron all call `notifyEvent` with pre-formatted vars. A disabled matrix cell suppresses automatically (engine). The expiry cron fires under the EXISTING markers (no re-send/re-meter). No double-metering. Each event fires once per genuine flip. Affected specs get a MessagingService mock; new tests assert eventKey+customerId+vars + non-firing on unrelated flips. `messaging.service.spec.ts` untouched.

## Work Packages

### WP1 — formatters + resolveSystemSenderId + notifyEvent + new spec

files:

- `apps/api/src/messaging/messaging.helpers.ts` (append)
- `apps/api/src/messaging/messaging.service.ts` (imports + 2 methods)
- `apps/api/src/messaging/messaging-notify.spec.ts` (NEW)

**1a. `messaging.helpers.ts` — append:**

```ts
// ─── P6-5: trigger-side formatters (STORED values only — no money math) ───────
const USD_FORMAT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Format a stored money value (Prisma Decimal | number | string) as "$1,234.50". */
export function formatMoney(value: unknown): string {
  const n = Number(value ?? 0);
  return USD_FORMAT.format(Number.isFinite(n) ? n : 0);
}

/** Format a date as "July 14, 2026" (invoice-email style); "" when absent/invalid. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
```

**1b. `messaging.service.ts`** — add `UserRole, UserStatus` to the `@prisma/client` import.

**1c. `messaging.service.ts` — insert after `notify()` closes:**

```ts
  /**
   * P6-5: resolve a User id usable as Message.senderId for system-originated
   * sends (crons / userless endpoints). Oldest ACTIVE TENANT_ADMIN, else oldest
   * ACTIVE OPERATOR (no Tenant.ownerId exists). Null → callers SKIP.
   */
  async resolveSystemSenderId(tenantId: string | null | undefined): Promise<string | null> {
    if (!tenantId) return null;
    const admin = await this.prisma.user.findFirst({
      where: { tenantId, role: UserRole.TENANT_ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (admin) return admin.id;
    const operator = await this.prisma.user.findFirst({
      where: { tenantId, role: UserRole.OPERATOR, status: UserStatus.ACTIVE, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return operator?.id ?? null;
  }

  /**
   * P6-5: trigger-facing convenience around notify(). NEVER rejects (fire-and-
   * forget AFTER a business write commits). senderId=null → resolve the system
   * sender; no sender → skip. Auto-fills customerName from Customer.businessName.
   */
  async notifyEvent(
    eventKey: NotificationEvent,
    args: { customerId: string; senderId: string | null; vars?: Record<string, string | number> },
  ): Promise<void> {
    try {
      const senderId = args.senderId ?? (await this.resolveSystemSenderId(this.prisma.getTenantId()));
      if (!senderId) {
        this.logger.warn(`notifyEvent(${eventKey}) skipped: no resolvable system sender`);
        return;
      }
      let vars = args.vars ?? {};
      if (vars.customerName === undefined) {
        const customer = await this.prisma.forTenant().customer.findUnique({
          where: { id: args.customerId },
          select: { businessName: true },
        });
        vars = { ...vars, customerName: customer?.businessName ?? "Customer" };
      }
      await this.notify(eventKey, { customerId: args.customerId, senderId, vars });
    } catch (err) {
      this.logger.warn(`notifyEvent(${eventKey}) failed: ${err instanceof Error ? err.message : err}`);
    }
  }
```

(Confirm `this.logger` exists on MessagingService; if not, use the file's logging idiom. `NotificationEvent` already imported.)

**1d. `messaging-notify.spec.ts` (NEW)** — cover: formatMoney (16.47→$16.47, "1234.5"→$1,234.50, Decimal(10)→$10.00, null→$0.00, non-number→$0.00); formatDate (Date→matches /2026/, null/undefined/invalid→""); resolveSystemSenderId (prefers ACTIVE TENANT_ADMIN, falls back OPERATOR, null when neither / null tenant no-query); notifyEvent (explicit senderId + auto-fill customerName from businessName; caller-supplied customerName not overwritten + no lookup; senderId=null resolves from tenant ctx "test-tenant"; SKIP no-notify-no-throw when no sender; never rejects when notify throws). Providers: MessagingService + mock PrismaService(createMockPrisma)+MeterService+MESSAGE_PROVIDER; `jest.spyOn(service,"notify").mockResolvedValue([])`. (Full spec as authored — implement verbatim.) `messaging.service.spec.ts` UNTOUCHED.

### WP2 — orders.service changeStatus trigger + OrdersModule + spec

files:

- `apps/api/src/orders/orders.service.ts`
- `apps/api/src/orders/orders.module.ts`
- `apps/api/src/orders/orders.service.spec.ts`

brief: map CONFIRMED/OUT_FOR_DELIVERY/DELIVERED → the events; fire after the status write in the same spot as the existing `notifMap` push block. Add `NotificationEvent` to the prisma import + `import { MessagingService }` + `import { formatDate, formatMoney }`; inject `messaging` (last ctor param). Insert AFTER the push block (~:1565), BEFORE `return updated`:

```ts
// P6-5: customer notification via the rules matrix (fire-and-forget AFTER
// the status write; notify() no-ops on a disabled cell + meters itself).
const messagingEventMap: Partial<Record<OrderStatus, NotificationEvent>> = {
  [OrderStatus.CONFIRMED]: NotificationEvent.ORDER_CONFIRMED,
  [OrderStatus.OUT_FOR_DELIVERY]: NotificationEvent.OUT_FOR_DELIVERY,
  [OrderStatus.DELIVERED]: NotificationEvent.DELIVERED,
};
const messagingEvent = messagingEventMap[dto.status];
if (messagingEvent) {
  let driverName = "your driver";
  if (messagingEvent === NotificationEvent.OUT_FOR_DELIVERY && order.routeRunId) {
    const run = await this.prisma.forTenant().routeRun.findUnique({
      where: { id: order.routeRunId },
      select: { driver: { select: { contactName: true } } },
    });
    driverName = run?.driver?.contactName ?? "your driver";
  }
  const vars: Record<string, string> = {
    orderNumber: order.orderNumber ?? "",
    ...(messagingEvent === NotificationEvent.ORDER_CONFIRMED
      ? {
          deliveryDate: formatDate(order.requestedDeliveryDate),
          orderTotal: formatMoney(updated.total),
        }
      : {}),
    ...(messagingEvent === NotificationEvent.OUT_FOR_DELIVERY ? { driverName } : {}),
    ...(messagingEvent === NotificationEvent.DELIVERED
      ? { orderTotal: formatMoney(updated.total) }
      : {}),
  };
  this.messaging
    .notifyEvent(messagingEvent, { customerId: order.customerId, senderId: user.sub || null, vars })
    .catch(() => {});
}
```

`orders.module.ts`: import + add `MessagingModule` to `imports` (acyclic). Spec: import MessagingService + a `messaging = { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn().mockResolvedValue(undefined) }` provider; add tests inside `describe("changeStatus")` — CONFIRMED fires ORDER_CONFIRMED (customerId cust-1, senderId user-op, vars orderNumber+orderTotal "$16.47"), DELIVERED fires with stored total formatted, OUT_FOR_DELIVERY fires with driverName "your driver" (no routeRunId), CANCELLED fires nothing.

### WP3 — invoices.service send/sendEmail trigger + InvoicesModule + spec

files:

- `apps/api/src/invoices/invoices.service.ts`
- `apps/api/src/invoices/invoices.module.ts`
- `apps/api/src/invoices/invoices.service.spec.ts`

brief: fire INVOICE_SENT once on the DRAFT→SENT flip, AFTER the Serializable tx, in BOTH `send()` + `sendEmail()`. **send()/sendEmail() have no user param (van-sale path calls send userless) → `senderId: null`.** Add `NotificationEvent` to the prisma import + `import { MessagingService }` + `import { formatDate, formatMoney }`; inject `messaging`. In `send()` after `emitInvoiceUpdated` (~:1618), before `if (auto.applied>0)`:

```ts
// P6-5: INVOICE_SENT (EMAIL/PORTAL only — G12 blocks WA/SMS in the engine).
// Once, on the DRAFT→SENT flip; a re-send doesn't re-notify. System sender.
if (inv.status === InvoiceStatus.DRAFT) {
  this.messaging
    .notifyEvent(NotificationEvent.INVOICE_SENT, {
      customerId: updated.customerId,
      senderId: null,
      vars: {
        invoiceNumber: updated.invoiceNumber,
        invoiceTotal: formatMoney(updated.total),
        dueDate: formatDate(updated.dueDate),
      },
    })
    .catch(() => {});
}
```

In `sendEmail()` after its `emitInvoiceUpdated` (~:1710), before `return {success…}`: same block but add `customerName: inv.customer?.businessName ?? "Customer"` to vars (customer already loaded). Do NOT touch `sendReminder` (deferred). `invoices.module.ts`: import + add `MessagingModule`. Spec: mock MessagingService provider; tests inside the send() describe — DRAFT→SENT fires INVOICE_SENT once (customerId c1, senderId null, vars invoiceNumber/invoiceTotal "$10.00"/dueDate ""); re-send of already-SENT fires nothing.

### WP4 — change-requests.create + routes DELIVERED triggers + module imports + specs

files:

- `apps/api/src/orders/change-requests.service.ts`
- `apps/api/src/routes/routes.service.ts`
- `apps/api/src/routes/routes.module.ts`
- `apps/api/src/orders/change-requests.service.spec.ts`
- `apps/api/src/routes/routes.service.spec.ts`

brief: **change-requests.create** — wire ORDER_CHANGED_AT_DOOR at the existing P6-5 anchor. Restructure `create()` to capture the created row into `const created = await ...create({...})` (data object UNCHANGED), then fire (fire-and-forget) `notifyEvent(ORDER_CHANGED_AT_DOOR, { customerId: order.customerId, senderId: user.sub||null, vars: { orderNumber: order.orderNumber??"", changeSummary: this.summarizeChange(dto.type, payload), orderTotal: formatMoney(order.total) } })`, then `return created`. Add a private `summarizeChange(type, payload)` (ADD_ITEM→`add ${qty} × ${productName??"item"}`, CHANGE_QTY→`quantity changed to ${newQty}`, REMOVE_ITEM→"item removed", NOTE→`${text??"note added"}`). Update the stale `notifyRequester` doc comment. Add `NotificationEvent` to prisma import + `import { MessagingService }` + `formatMoney`; inject `messaging`.
**routes DELIVERED** — driver completion bypasses changeStatus. Add `NotificationEvent` + `import { MessagingService }` + `formatMoney`; inject `messaging`. Widen BOTH stop fetches (completeStop ~:1139 + completeWithPayment ~:1293) `orders` select to add `orderNumber, total`. After EACH tenantTransaction closes (~:1239, ~:1426), before the autoComplete block, insert:

```ts
// P6-5: DELIVERED per order this completion flipped (driver bypasses
// changeStatus). AFTER the tx, fire-and-forget; skip already CANCELLED/DELIVERED.
for (const o of stop.orders) {
  if (o.status === OrderStatus.CANCELLED || o.status === OrderStatus.DELIVERED) continue;
  this.messaging
    .notifyEvent(NotificationEvent.DELIVERED, {
      customerId: o.customerId,
      senderId: user.sub || null,
      vars: { orderNumber: o.orderNumber ?? "", orderTotal: formatMoney(o.total) },
    })
    .catch(() => {});
}
```

`routes.module.ts`: import + add `MessagingModule` to imports. Specs: both get a MessagingService mock provider (`notifyEvent: jest.fn().mockResolvedValue(undefined)`); change-requests test — ADD_ITEM create fires ORDER_CHANGED_AT_DOOR (changeSummary contains the product name), a closed-window create() throw fires nothing; routes test — completeStop fires DELIVERED once for the eligible order, skips CANCELLED/DELIVERED (clone the existing txMock scaffolding).

### WP5 — LICENSE_EXPIRING cron under the existing markers + spec

files:

- `apps/api/src/authorizations/authorization-expiry.service.ts`
- `apps/api/src/authorizations/authorizations.module.ts`
- `apps/api/src/authorizations/authorization-expiry.service.spec.ts`

brief: add `NotificationEvent` import + `import { MessagingService }` + `formatDate`; inject `messaging`. Inside the expire loop, AFTER the existing `await this.notify(auth, operators, ...)` (~:121), before `expired++`, AND inside the warn loop after its `notify` (~:157) before `warned++`, insert (both under the SAME existing marker guard → idempotent):

```ts
await this.messaging.notifyEvent(NotificationEvent.LICENSE_EXPIRING, {
  customerId: auth.customerId,
  senderId: null,
  vars: { expiryDate: formatDate(auth.expiresAt) },
});
```

(In the cron the call is awaited — no latency concern; notifyEvent never rejects; each row is already in its own try/catch. `processTenant` runs inside `tenantCtx.run`, so `getTenantId()` resolves the tenant for the system sender.) `authorizations.module.ts`: import + add `MessagingModule` to imports (acyclic — MessagingModule doesn't import AuthorizationsModule). Spec: MessagingService mock provider; flip fires LICENSE_EXPIRING once (customerId c1, senderId null, vars expiryDate contains "2026"), a non-gated row fires nothing; warning fires once, an already-stamped bucket fires nothing.

### WP6 — code-map + verify

files: `.claude/code-map/api.md`
brief: update the messaging entry (notifyEvent/resolveSystemSenderId/formatMoney/formatDate signatures) + note the 5 trigger sites (orders.changeStatus, invoices.send/sendEmail, change-requests.create, routes.completeStop/completeWithPayment, authorization-expiry) now depend on MessagingService (all modules gained the acyclic import). Bump `.claude/code-map/_meta.json`. Run `npm run verify`.

## Assumptions (verify at edit time)

1. System sender = oldest ACTIVE TENANT_ADMIN → OPERATOR (no Tenant.ownerId; mirrors authorization-expiry:169-174). No sender → skip + warn.
2. send()/sendEmail() have NO user param (invoices.controller:136-146; van-sale calls send userless) → senderId:null.
3. formatMoney/formatDate are NEW (no shared formatter); format STORED totals only, zero recompute.
4. ORDER_CONFIRMED.deliveryDate = Order.requestedDeliveryDate ("" when null).
5. OUT_FOR_DELIVERY is changeStatus-only — no routes wiring; {{driverName}} via order.routeRunId→run.driver.contactName, fallback "your driver".
6. ORDER_CHANGED_AT_DOOR fires at request CREATION with the order's current stored total.
7. No module imports MessagingModule yet among Orders/Invoices/Routes/Authorizations — all gain it, all acyclic (MessagingModule→EntitlementsModule→nothing).
8. Every spec `notifyEvent` mock MUST `mockResolvedValue(undefined)` (call sites chain `.catch()`).
9. NO migration; PAYMENT_REMINDER is the single deferred item.

### Critical Files

- apps/api/src/messaging/messaging.service.ts
- apps/api/src/messaging/messaging.helpers.ts
- apps/api/src/orders/orders.service.ts
- apps/api/src/invoices/invoices.service.ts
- apps/api/src/authorizations/authorization-expiry.service.ts
