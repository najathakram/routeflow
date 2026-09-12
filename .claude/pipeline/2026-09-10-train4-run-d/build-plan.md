# Build plan: train 4 Run D, B131 + B141 (a removed customer keeps firing and keeps portal access)

> **Stage S5 ("how").** Written 2026-09-10. Status: `APPROVED` (for launch).
> **Model note:** bug-pipeline policy assigns S5 to Fable 5.1. Fable was out of usage credits on 2026-09-10 (a direct
> probe returned HTTP 429), so **Opus 5 wrote this plan as the documented fallback**. It transcribes the Fable cause ruling
> and the owner rulings of 2026-09-10 (`.claude/pipeline/2026-09-10-train4-run-d/cause-ruling.md`; its final
> section "OWNER RULINGS 2026-09-10" supersedes the earlier lines, and **drops refresh-token revocation**). It designs no
> behavior beyond them.
> Mode `bugfix`, scale `major`: the buyer guard is tenancy/auth, and the recurring and invoice paths are money. The
> implementation and review agents receive only this file and [bug-test-plan.md](./bug-test-plan.md), and both must stand alone.
> Grounding: every cited line was re-read at master `5b3b3c4e` (branch base; edd379bf..5b3b3c4e touches nothing in this run's radius — verified 2026-09-10) on 2026-09-10 and matched. Lines are approximate
> (±5); anchor on the quoted code, not the number.

---

## Objective

"Remove customer" on web always takes the **soft** branch of `CustomersService.deleteCustomer`
(`apps/api/src/customers/customers.service.ts` ~2039-2049). It writes only `Customer.deletedAt = new Date()` and
`User.status = "INACTIVE"` in one `tenantTransaction`. `restoreCustomer` (~1965-1984, the 8-second Undo) is its exact
inverse: `deletedAt = null` plus the prior user status. Nothing else reads `deletedAt` on these paths, so:

- **B131.** The removed customer's standing orders still generate every matching weekday
  (`OrderTemplatesService.generateDailyOrders`, `@LeaderCron("0 6 * * *", "order-templates.generateDailyOrders")`, query
  ~316). Their recurring invoices still generate at midnight and are **emailed** when `autoSend`
  (`RecurringInvoicesService.generateDueRecurringInvoices`, query ~400, email at ~323-325). And an operator can still
  create a manual invoice for them (`InvoicesService.create`, ~342-345).
- **B141.** The removed customer's buyer keeps full portal access. `BuyerSellerContextGuard.canActivate`
  (`apps/api/src/buyer/guards/buyer-seller-context.guard.ts` ~38-45) checks only `CustomerLink.status = "ACTIVE"`, and the
  soft delete never touches the link. `BuyerService.getSellers` (`apps/api/src/buyer/buyer.service.ts` ~28-66) keeps
  listing the dead seller in the switcher.

The fix is **stateless and restore-symmetric**: filter or refuse on `customer.deletedAt`, write no new state, and leave
the soft-delete and restore code untouched. Restoring a customer (clearing `deletedAt`) brings back every behavior with no
other write. Precisely: restore resumes the schedule; the first tick after restore generates at most one current-cycle
invoice/order (B46 rule — the generator advances from `max(due, now)`, so a long removal is not replayed as a backlog).
That single make-up document is accepted behaviour, not a defect, and needs no code of its own.

### Requirements

- `R1`: `generateDailyOrders` never generates an order from a template whose customer has `deletedAt` set.
- `R2`: `generateDueRecurringInvoices` never generates, and so never emails, an invoice for a customer with `deletedAt` set.
- `R3`: `InvoicesService.create` refuses a customer with `deletedAt` set with the same `NotFoundException("Customer not found")`
  as a missing one, **before** any write.
- `R4`: `BuyerSellerContextGuard` refuses (`ForbiddenException("No active connection to this seller")`, the existing
  message) any request whose ACTIVE link belongs to a customer with `deletedAt` set, and leaves `req.buyerCustomer` unset.
  This covers all 45 guarded routes of `buyer.controller.ts` and the class-level guard of
  `apps/api/src/payment-requests/buyer-payments.controller.ts`, verified 2026-09-10.
- `R5`: `GET /buyer/sellers` (`getSellers`) omits every link whose customer has `deletedAt` set.
- `R6` (restore symmetry): with `deletedAt` back to `null`, R1 to R5 all admit the customer again. There are no
  `isActive` writes, no `CustomerLink` writes, and no refresh-token or session writes. Scope of the "no other write
  while removed" claim: it holds for **the fixed paths** — both crons, `InvoicesService.create`, the seller-context
  guard, `getSellers`, and (added in review round 1) `requestSeller` / `getInviteDetails` / `acceptInvite`.
  `CustomersService.approveBuyerRequest` can still write a removed customer's `CustomerLink`; it remains a follow-up
  (see Sibling notes).

**In scope:** the five one-clause edits in WP1/WP2 and the tests in TP1/TP2.

**Explicitly out of scope (the scope fence):**

- **Refresh-token revocation of any kind** (owner ruling 2026-09-10). `BuyerRefreshToken`
  (`apps/api/prisma/schema/tenancy.prisma` ~425-440) has no `tenantId`, so revoking would log the buyer out of every other
  wholesaler's portal. The guard refuses the removed seller on the very next request, and that is the whole B141 fix.
- `isActive = false` writes to templates or recurring invoices. They are not restore-symmetric, because restore cannot know
  what was already paused.
- Any edit to `customers.service.ts` (`deleteCustomer`, `restoreCustomer`, `disconnectPortal`, `getPortalStatus`,
  `approveBuyerRequest`), `buyer-auth.service.ts`, `google-oauth.service.ts` **other than the `sellerCount` where-clause
  amended below**, any controller, the unguarded account-level
  routes other than `getSellers` **and the three reconnect routes amended below**, decorators (`@LeaderCron` stays; a bare
  `@Cron(` fails `no-bare-cron.spec.ts`), schema, migrations, web, mobile.

> **Fence amendment, review round 1 (2026-09-10).** The fence originally excluded every account-level buyer route but
> `getSellers`. Review found that leaves the reconnect door open: `requestSeller` matched a removed customer (409 "already
> connected", or an ACTIVE/PENDING `CustomerLink` write plus a seller email/socket emit for a customer the seller removed),
> and `getInviteDetails`/`acceptInvite` still redeemed a pre-removal invite. Those three reads now carry the same
> `deletedAt`-null filter (round-1 fix in `buyer.service.ts`), pinned by REG-B141 T9/T10. `customers.service.ts` stays
> untouched.

> **Fence amendment, review round 2 (2026-09-10).** The fence above also excluded `google-oauth.service.ts`. Review
> found `sellerCount = customerLink.count({ buyerAccountId, status: "ACTIVE" })` (~615) decides the mobile Google-login
> branch (`sellerCount === 0` shows the "not connected to any supplier" message) — an unfiltered count is behavioral,
> not cosmetic. It now carries the same `customer: { deletedAt: null }` filter as `BuyerService.getSellers` (round-2 fix
> in `google-oauth.service.ts`), pinned by the google-oauth removed-customer spec.

> **Fence amendment, review round 2 (2026-09-10) — web client.** The fence above listed `web` as out of scope. With
> refresh-token revocation ruled out (owner, above), a restored `activeSeller` whose customer record the seller removed
> would 403 every guarded request with nothing in the UI to explain it. `BuyerAuthProvider`
> (`apps/web/lib/buyer-auth-context.tsx`) therefore reconciles the restored/refreshed `activeSeller` against
> `GET /buyer/sellers` by `linkId` — clearing state plus the stored copy so the portal pages' `!activeSeller` redirect
> takes over — on both mount paths, on `refreshSellers()` and after `login()`. A rejected fetch never reaches the
> reconcile, so it can never clear on a network error. Admitted files: `apps/web/lib/buyer-auth-context.tsx` and the new
> `apps/web/lib/buyer-auth-context.test.tsx` (W1-W5). No other web file is touched; mobile stays out of scope.

- Manual "generate now" for a removed customer's order template (`generateOrder` / `generateOrderForUser`) and
  `createInvoiceFromOrder` for an already-placed order. See Sibling notes.
- Any data repair. Read-only reports only (see Data repair); none is written in this run.

---

## Constraints & conventions

- **Stack:** NestJS 11, Prisma 7, Postgres. `this.prisma.forTenant().<model>` is the tenant-scoped client. Its
  `findMany` shallow-merges `tenantId` into `args.where` (`apps/api/src/prisma/prisma.service.ts` ~251-266), so a nested
  relation filter passes through unchanged. The guard and `getSellers` use the unscoped `this.prisma.customerLink`.
  `Customer` has no row-level security (no `ENABLE ROW LEVEL SECURITY` in `apps/api/prisma/migrations`). Both files
  already `include` the `customer` relation from the same client, so a relation filter on it reads the same rows.
- **Relation shape:** `OrderTemplate.customerId`, `RecurringInvoice.customerId` and `CustomerLink.customerId` are all
  **required** (`String`, not `String?`). `customer: { deletedAt: null }` is therefore a plain to-one relation filter, and
  it cannot drop a customer-less row, because none exists.
- **Tests:** Jest, unit only. `apps/api` has NO jest config file: the config is inline in `apps/api/package.json` (`rootDir:
"src"`, `testRegex: ".*\\.spec\\.ts$"`, campaign reporter). Run specs as `cd apps/api && npx jest
<path> -t <pattern> --reporters=default`. Specs use `createMockPrisma()` from `apps/api/src/testing/prisma-mock.ts`, whose `forTenant()`
  returns the same model mocks. **No DB-lane spec in this run.** The ruling puts B131/B141 on unit tests, and no
  `*.db.spec.ts` touches these tables.
- **Lint/format:** `npm run check-types -w apps/api` (`tsc --noEmit`), `npm run lint -w apps/api`. Prettier: semicolons,
  double quotes, printWidth 100, trailing commas.
- **Lessons carried:** L-081 (a where-only fix is invisible to a result-injecting mock, so the new tests use a
  `where`-honoring fake, and `create()` gates on the row it just read with an exclude-list check a fixture without
  `deletedAt` still passes); L-060 (every pin is green today; a red pin escalates to a fix, it is never shipped red);
  L-097 (REG tokens byte-for-byte in titles); L-063 (`--reporters=default` on every partial jest run); L-062 (specs never
  read outside `apps/api`); L-072 (the duplicated portal-link logic is recorded as a note, not widened into).
- **Must NOT change:** the soft-delete and restore code in `customers.service.ts`; the guard's error messages and the
  shape of `req.buyerCustomer`; `getSellers`' F4 redaction (`customer: link.status === "ACTIVE" ? link.customer : null`);
  both `@LeaderCron` decorators and names; the existing `include`s; `generateInvoiceFromTemplate`'s claim, advance and
  failure handling (REG-B9, REG-B46, REG-B106).
- **Do not introduce:** new columns, flags or state; a second query to read `deletedAt` where a filter or the row already
  carries it — **except** the per-tenant-per-day suppressed `count()` on the two cron paths (`order-templates.service.ts`
  ~322, `recurring-invoices.service.ts` ~406) and the guard's refusal-path-only `customerLink.findFirst` diagnostic
  (`buyer-seller-context.guard.ts` ~61), which issues no extra query on the happy path; token deletion; a new test helper
  file under `apps/api/src/testing/` (the fake is inlined per spec, see below).
- **Landmines:**
  - `generateDailyOrders` does not self-repair a missed day (see the header of `apps/api/src/common/cron-lock.ts`). That is
    irrelevant to this fix, but never "fix" it here.
  - A `-t` pattern matches describe plus test title, so **no describe title may contain `REG-`**. Otherwise pins leak into
    the red gate.
  - Run A of train 4 also edits `apps/api/src/invoices/invoices.service.ts` (`deleteInvoice`, ~5323), far from `create()`
    (~342). The regions are disjoint; see Risks for landing order.

---

## Shared test code (inline a copy in EACH of the four spec files that uses it; do not create a helper file)

```ts
// Honest stand-in for Postgres: applies the `where` the service actually sends, so a where-only fix is
// observable (L-081: a mock that injects a fixed result cannot see one). Strict: an unmodelled filter
// shape throws instead of silently matching.
function matchesWhere(row: any, where: any = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "customer") {
      const rel = (cond as any)?.is ?? cond;
      if (
        !rel ||
        !Object.prototype.hasOwnProperty.call(rel, "deletedAt") ||
        rel.deletedAt !== null
      ) {
        throw new Error(`matchesWhere: unsupported customer filter ${JSON.stringify(cond)}`);
      }
      if (row.customer.deletedAt !== null) return false;
      continue;
    }
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as any;
      if ("has" in c) {
        if (!row[key].includes(c.has)) return false;
      } else if ("in" in c) {
        if (!c.in.includes(row[key])) return false;
      } else if ("lte" in c) {
        if (!(row[key] <= c.lte)) return false;
      } else {
        throw new Error(`matchesWhere: unsupported filter on ${key}: ${JSON.stringify(cond)}`);
      }
      continue;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

const REMOVED_AT = new Date("2026-09-01T00:00:00.000Z");
```

The invoices spec (T4/T5/P3) does not need `matchesWhere`; it needs only `REMOVED_AT`.

---

## Test packages

Authored FIRST. Test-only: no source edits. File lists are disjoint from each other and from WP1/WP2.

### TP1 — B131 tests (T1-T5, P1-P3)

- **writes:**
  - `apps/api/src/order-templates/order-templates.removed-customer.spec.ts` (**NEW**, created by this change)
  - `apps/api/src/recurring-invoices/recurring-invoices.service.spec.ts` (append one top-level describe)
  - `apps/api/src/invoices/invoices.service.spec.ts` (append one nested describe; placement below)
- **tests:** T1, T2, T3, T4, T5, P1, P2, P3
- **must fail with (red gate):** T1 `received ["t-live","t-removed"]`; T2 `received ["c-live","c-removed"]`; T3 `sendEmail`
  called 1 time; T4 promise resolved (`{ id: "inv-2", ... }`); T5 `invoice.create` called 1 time. P1-P3 green.

**File 1, NEW `order-templates.removed-customer.spec.ts`** (exact skeleton; fill in only what is marked):

```ts
// @LeaderCron wraps the tick in a Postgres advisory lock (common/cron-lock.ts). There is no database here,
// so the lock is a PASS-THROUGH that still runs the body (same mock as recurring-invoices.service.spec.ts).
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

// <paste matchesWhere + REMOVED_AT from "Shared test code">

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
const templates = (removedAt: Date | null) => [
  {
    id: "t-live",
    customerId: "c-live",
    name: "Live",
    isActive: true,
    daysOfWeek: EVERY_DAY,
    items: [],
    customer: { id: "c-live", deletedAt: null },
  },
  {
    id: "t-removed",
    customerId: "c-removed",
    name: "Removed",
    isActive: true,
    daysOfWeek: EVERY_DAY,
    items: [],
    customer: { id: "c-removed", deletedAt: removedAt },
  },
];

describe("OrderTemplatesService.generateDailyOrders — removed customer (B131)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let createSpy: jest.SpyInstance;

  async function boot(rows: any[]) {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id: string, fn: () => unknown) => fn()) },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("10") } },
        { provide: OrdersService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }] as any);
    prisma.orderTemplate.findMany.mockImplementation((async (args: any) =>
      rows.filter((r) => matchesWhere(r, args?.where))) as any);
    prisma.order.findFirst.mockResolvedValue(null); // nothing generated yet today
    createSpy = jest
      .spyOn(service as any, "createOrderFromTemplate")
      .mockResolvedValue({ id: "o-1" });
  }

  it("REG-B131 T1: generateDailyOrders skips an active template whose customer was removed", async () => {
    await boot(templates(REMOVED_AT));
    await service.generateDailyOrders();
    expect(createSpy.mock.calls.map((c) => c[0].id)).toEqual(["t-live"]);
  });

  it("B131 P1: a restored customer's template fires again", async () => {
    await boot(templates(null));
    await service.generateDailyOrders();
    expect(createSpy.mock.calls.map((c) => c[0].id)).toEqual(["t-live", "t-removed"]);
  });
});
```

**File 2, append to `recurring-invoices.service.spec.ts`** (the file-level db-locks mock and the imports already exist; add
`matchesWhere`/`REMOVED_AT` once, above the new describe):

```ts
describe("RecurringInvoicesService.generateDueRecurringInvoices — removed customer (B131)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock; send: jest.Mock; sendEmail: jest.Mock };

  const ri = (id: string, customerId: string, autoSend: boolean, deletedAt: Date | null) => ({
    id,
    customerId,
    discount: 0,
    shippingFee: 0,
    notes: null,
    terms: null,
    autoSend,
    frequency: "MONTHLY",
    dayOfWeek: null,
    dayOfMonth: 1,
    isActive: true,
    nextRunAt: new Date("2026-07-01"),
    items: [{ description: "x", productId: null, qty: 1, unitPrice: 10, discount: 0, taxRate: 0 }],
    customer: { id: customerId, deletedAt },
  });

  async function boot(removedAt: Date | null) {
    prisma = createMockPrisma();
    invoices = {
      create: jest.fn().mockResolvedValue({ id: "inv-1" }),
      send: jest.fn().mockResolvedValue({ id: "inv-1" }),
      sendEmail: jest.fn().mockResolvedValue({ success: true }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TenantContextService,
          useValue: { run: jest.fn((_id: string, fn: () => unknown) => fn()) },
        },
        { provide: InvoicesService, useValue: invoices },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
    const rows = [
      ri("ri-live", "c-live", false, null),
      ri("ri-removed", "c-removed", true, removedAt),
    ];
    prisma.tenant.findMany.mockResolvedValue([{ id: "tn-1" }] as any);
    prisma.recurringInvoice.findMany.mockImplementation((async (args: any) =>
      rows.filter((r) => matchesWhere(r, args?.where))) as any);
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 }); // B9 CAS claim succeeds
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" } as any);
    prisma.invoice.update.mockResolvedValue({ id: "inv-1" } as any);
  }

  it("REG-B131 T2: generateDueRecurringInvoices never invoices a removed customer", async () => {
    await boot(REMOVED_AT);
    await service.generateDueRecurringInvoices();
    expect(invoices.create.mock.calls.map((c) => c[0].customerId)).toEqual(["c-live"]);
  });

  it("REG-B131 T3: generateDueRecurringInvoices never emails a removed customer's auto-send invoice", async () => {
    await boot(REMOVED_AT);
    await service.generateDueRecurringInvoices();
    expect(invoices.sendEmail).toHaveBeenCalledTimes(0);
  });

  it("B131 P2: a restored customer's recurring invoice generates again", async () => {
    await boot(null);
    await service.generateDueRecurringInvoices();
    expect(invoices.create.mock.calls.map((c) => c[0].customerId)).toEqual(["c-live", "c-removed"]);
  });
});
```

**File 3, append to `invoices.service.spec.ts`.** Insert as the LAST nested describe of `describe("InvoicesService")`,
immediately before that describe's closing `});`, which sits directly above the comment
`/** Invoice issue/due dates are CALENDAR dates ...` (~line 8150). It inherits the top-level `beforeEach` (~109). Add
`const REMOVED_AT = ...` inside the new describe; `NotFoundException` is already imported.

```ts
describe("create() — removed customer (B131)", () => {
  const dto = {
    customerId: "cust-1",
    items: [{ productId: "prod-plain", description: "Soda", qty: 2, unitPrice: 3 }],
  };
  // Same fixture as "create() does NOT touch the ledger for a purely non-regulated invoice" (RF-1).
  const arrange = (deletedAt: Date | null) => {
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      isTaxExempt: false,
      deletedAt,
    } as any);
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-plain", unitsPerBox: null, trackedCategoryId: null, trackedSubcategoryId: null },
    ] as any);
    prisma.invoice.findFirst.mockResolvedValue(null);
    prisma.invoice.create.mockResolvedValue({
      id: "inv-2",
      items: [],
      customer: {},
      payments: [],
    } as any);
  };

  it("REG-B131 T4: create() refuses a removed customer with the not-found 404", async () => {
    arrange(REMOVED_AT);
    await expect(service.create(dto as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("REG-B131 T5: create() for a removed customer writes no invoice row", async () => {
    arrange(REMOVED_AT);
    await service.create(dto as any).catch(() => undefined);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it("B131 P3: create() still invoices a live customer (fixture control)", async () => {
    arrange(null);
    await expect(service.create(dto as any)).resolves.toMatchObject({ id: "inv-2" });
  });
});
```

If P3 is red on the untouched tree, the fixture is incomplete, not the fix. Copy whatever else the RF-1 non-regulated test
stubs; never loosen T4/T5.

### TP2 — B141 tests (T6-T8, P4-P6)

- **writes:**
  - `apps/api/src/buyer/guards/buyer-seller-context.guard.spec.ts` (**NEW**, created by this change)
  - `apps/api/src/buyer/buyer-connect.spec.ts` (append one top-level describe at end of file)
- **tests:** T6, T7, T8, P4, P5, P6
- **must fail with (red gate):** T6 promise resolved with `true`; T7 `req.buyerCustomer` = `{ customerId: "c-1", ... }`;
  T8 `received ["acme-live","acme-removed"]`. P4-P6 green.

**File 4, NEW `buyer-seller-context.guard.spec.ts`:**

```ts
import { ForbiddenException } from "@nestjs/common";
import { BuyerSellerContextGuard } from "./buyer-seller-context.guard";

// <paste matchesWhere + REMOVED_AT from "Shared test code">

const link = (status: string, deletedAt: Date | null) => ({
  id: "l-1",
  buyerAccountId: "b-1",
  tenantId: "tn-1",
  customerId: "c-1",
  status,
  customer: {
    id: "c-1",
    userId: "u-1",
    businessName: "Acme Deli",
    email: "buyer@example.test",
    deletedAt,
  },
});

function boot(rows: any[]) {
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: "tn-1", slug: "acme", status: "ACTIVE" }),
    },
    customerLink: {
      findFirst: jest.fn(
        async (args: any) => rows.find((r) => matchesWhere(r, args?.where)) ?? null,
      ),
    },
  };
  const guard = new BuyerSellerContextGuard(prisma as any);
  const req: any = { user: { sub: "b-1" }, headers: { "x-tenant-slug": "acme" } };
  const ctx: any = { switchToHttp: () => ({ getRequest: () => req }) };
  return { guard, req, ctx };
}

describe("BuyerSellerContextGuard — removed customer (B141)", () => {
  it("REG-B141 T6: the seller-context guard refuses a removed customer's ACTIVE link", async () => {
    const { guard, ctx } = boot([link("ACTIVE", REMOVED_AT)]);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("REG-B141 T7: a refused removed customer never reaches req.buyerCustomer", async () => {
    const { guard, req, ctx } = boot([link("ACTIVE", REMOVED_AT)]);
    await guard.canActivate(ctx).catch(() => undefined);
    expect(req.buyerCustomer).toBeUndefined();
  });

  it("B141 P4: a live or restored customer passes the guard and populates req.buyerCustomer", async () => {
    const { guard, req, ctx } = boot([link("ACTIVE", null)]);
    await guard.canActivate(ctx);
    expect(req.buyerCustomer.customerId).toBe("c-1");
  });

  it("B141 P5: a DISCONNECTED link is still refused for a live customer", async () => {
    const { guard, ctx } = boot([link("DISCONNECTED", null)]);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
```

**File 5, append to `buyer-connect.spec.ts`** (all imports already exist; add `matchesWhere`/`REMOVED_AT` above the new
describe):

```ts
describe("BuyerService.getSellers — removed customer (B141)", () => {
  let service: BuyerService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const sellerLink = (slug: string, deletedAt: Date | null) => ({
    id: `l-${slug}`,
    buyerAccountId: "b-1",
    status: "ACTIVE",
    linkedAt: new Date("2026-08-01"),
    tenantId: `tn-${slug}`,
    tenant: { id: `tn-${slug}`, name: slug, slug },
    customer: {
      id: `c-${slug}`,
      businessName: "Retail Corner",
      email: "c@example.test",
      deletedAt,
    },
  });

  async function boot(removedAt: Date | null) {
    prisma = createMockPrisma();
    const rows = [sellerLink("acme-live", null), sellerLink("acme-removed", removedAt)];
    prisma.customerLink.findMany.mockImplementation((async (args: any) =>
      rows.filter((r) => matchesWhere(r, args?.where))) as any);
    prisma.tenantConfig.findFirst.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BuyerService,
        { provide: PrismaService, useValue: prisma },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        {
          provide: RouteFlowGateway,
          useValue: { emitBuyerAutoLinked: jest.fn(), emitBuyerConnectRequest: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(BuyerService);
  }

  it("REG-B141 T8: GET /buyer/sellers hides a seller whose customer record was removed", async () => {
    await boot(REMOVED_AT);
    expect((await service.getSellers("b-1")).map((s) => s.tenant.slug)).toEqual(["acme-live"]);
  });

  it("B141 P6: getSellers lists a restored seller again", async () => {
    await boot(null);
    expect((await service.getSellers("b-1")).map((s) => s.tenant.slug)).toEqual([
      "acme-live",
      "acme-removed",
    ]);
  });
});
```

The fixture strings above are placeholders (`acme`-style, `example.test`) and carry no client identifiers. Prettier may
re-wrap the dense object literals; that is fine.

**Red gate command** (runs only the REG tests; every one must fail on its stated value, none may pass):

```bash
cd apps/api && npx jest src/order-templates/order-templates.removed-customer src/recurring-invoices/recurring-invoices.service src/invoices/invoices.service -t "REG-B131" --reporters=default
cd apps/api && npx jest src/buyer/guards/buyer-seller-context.guard src/buyer/buyer-connect -t "REG-B141" --reporters=default
```

---

## Work packages

Two disjoint packages, one wave. Both `effort: high`: WP1 touches money files (recurring invoices, invoices), WP2
touches the buyer auth/tenancy boundary. Each diff is a few lines. **Transcribe the exact code; do not redesign it.**

### WP1 — B131: removed customers drop out of both crons and out of manual invoicing

- **files:** `apps/api/src/order-templates/order-templates.service.ts`,
  `apps/api/src/recurring-invoices/recurring-invoices.service.ts`, `apps/api/src/invoices/invoices.service.ts`
- **satisfies:** R1, R2, R3, R6
- **provenBy:** T1, T2, T3, T4, T5, P1, P2, P3
- **dependsOn:** none
- **effort:** high
- **brief:** one clause per file, exactly as below. Touch nothing else in these files.
- **exact code:**

`order-templates.service.ts`, inside `generateDailyOrders` (~316). Anchor:
`where: { isActive: true, daysOfWeek: { has: dayOfWeek } },`

```ts
const templates = await this.prisma.forTenant().orderTemplate.findMany({
  // REG-B131: a removed (soft-deleted) customer's standing orders stop firing. Stateless on
  // purpose: restoreCustomer() clears deletedAt and the template resumes with no other write.
  where: { isActive: true, daysOfWeek: { has: dayOfWeek }, customer: { deletedAt: null } },
  include: { items: true },
});
```

`recurring-invoices.service.ts`, inside `generateDueRecurringInvoices` (~400). Anchor:
`where: { isActive: true, nextRunAt: { lte: new Date() } },`

```ts
const due = await this.prisma.forTenant().recurringInvoice.findMany({
  // REG-B131: never generate (or auto-email) for a removed customer. Stateless, so a restored
  // customer's schedule resumes on its own; nextRunAt is left untouched while removed.
  where: { isActive: true, nextRunAt: { lte: new Date() }, customer: { deletedAt: null } },
  include: { items: true, customer: true },
});
```

`invoices.service.ts`, in `create(dto)` (~342-345). Replace only the `if (!customer)` line:

```ts
const customer = await this.prisma
  .forTenant()
  .customer.findUnique({ where: { id: dto.customerId } });
// REG-B131: a removed (soft-deleted) customer cannot be invoiced; same 404 as a missing one. Checked
// on the row just read (L-081), so restoreCustomer() re-enables it with no other write.
if (!customer || customer.deletedAt) throw new NotFoundException("Customer not found");
```

Why a row check and not a `where` key here: it is the owner's `customer: { deletedAt: null }` rule applied to a
single-row read. It keeps `findUnique` on its unique key (the `forTenant()` findUnique path post-filters by tenant;
see the `tenant-findunique*.db.spec.ts` pins), and every existing fixture without `deletedAt` still passes.

### WP2 — B141: the guard refuses a removed customer; the seller switcher hides one

- **files:** `apps/api/src/buyer/guards/buyer-seller-context.guard.ts`, `apps/api/src/buyer/buyer.service.ts`
- **satisfies:** R4, R5, R6
- **provenBy:** T6, T7, T8, P4, P5, P6
- **dependsOn:** none
- **effort:** high
- **brief:** add the relation filter to the one `customerLink` read in each file. Messages, `include`/`select`, the
  `req.buyerCustomer` shape and getSellers' F4 redaction stay byte-identical. **No token, session or link writes.**
- **exact code:**

`buyer-seller-context.guard.ts` (~37-45):

```ts
// Verify active CustomerLink. REG-B141: removing a customer leaves its link ACTIVE on purpose (restore
// must bring the portal back untouched), so the removal is enforced here, on every seller-scoped
// request. No refresh-token revocation: BuyerRefreshToken is account-wide (no tenantId).
const link = await this.prisma.customerLink.findFirst({
  where: {
    buyerAccountId: buyer.sub,
    tenantId: tenant.id,
    status: "ACTIVE",
    customer: { deletedAt: null },
  },
  include: {
    customer: {
      select: { id: true, userId: true, businessName: true, email: true },
    },
  },
});
```

`buyer.service.ts`, `getSellers` (~29-30):

```ts
    const links = await this.prisma.customerLink.findMany({
      // REG-B141: hide a seller that removed this buyer's customer record, so the switcher never offers a
      // seller whose routes the guard refuses. Stateless: restoring the customer lists it again.
      where: {
        buyerAccountId,
        status: { in: ["ACTIVE", "INVITED", "PENDING_SELLER_APPROVAL"] },
        customer: { deletedAt: null },
      },
```

(The `include`, `orderBy` and the rest of `getSellers` are unchanged.)

### Package map

| Pkg | satisfies      | provenBy     | dependsOn | Wave  |
| --- | -------------- | ------------ | --------- | ----- |
| TP1 | —              | T1-T5, P1-P3 | —         | tests |
| TP2 | —              | T6-T8, P4-P6 | —         | tests |
| WP1 | R1, R2, R3, R6 | T1-T5, P1-P3 | —         | 1     |
| WP2 | R4, R5, R6     | T6-T8, P4-P6 | —         | 1     |

Every R# is covered; every T#/P# is covered.

---

## Acceptance criteria

1. `R1`: T1 green. `generateDailyOrders`' `findMany` where carries `customer: { deletedAt: null }` beside the unchanged
   `isActive`/`daysOfWeek` keys.
2. `R2`: T2 and T3 green. `generateDueRecurringInvoices`' `findMany` where carries `customer: { deletedAt: null }`.
   `include` is unchanged.
3. `R3`: T4 and T5 green. The refusal happens before any write, with the existing message `"Customer not found"`.
4. `R4`: T6 and T7 green. The guard's changes are the where key plus a refusal-path-only diagnostic `Logger.warn` (one
   extra query only when refusing); both thrown messages are byte-identical.
5. `R5`: T8 green. `getSellers`' F4 redaction line is unchanged.
6. `R6`: P1, P2, P3, P4 and P6 green. The diff contains **no** writes: no `isActive`, `CustomerLink`, `BuyerRefreshToken`
   or `deletedAt` writes, and no `deleteMany`.
7. Negative: P5 green; a DISCONNECTED link is still refused. Every pre-existing test in the touched spec files is still green.
8. Decorators: `@LeaderCron` on both crons is unchanged, and `src/common/no-bare-cron.spec.ts` is green.
9. Web (round-2 fence amendment): W1-W5 green. A restored or refreshed `activeSeller` that is absent from the fetched
   sellers list is cleared in state and in storage; a rejected fetch clears nothing; `npm run check-types -w apps/web` is
   clean.
10. Deploy day: no row changes. Removed customers stop generating from the next tick, and their buyers get 403
    `"No active connection to this seller"` on their next seller-scoped request and no longer see that seller in the
    switcher. Their other wholesalers are unaffected.

---

## Verification commands

Per round:

```bash
npm run check-types -w apps/api
npm run lint -w apps/api
npm run check-types -w apps/web
```

Final (unit only; no DB-lane spec is touched by this run, so no DB-lane command is owed). The web lane covers the
round-2 fence amendment for `apps/web/lib/buyer-auth-context.tsx`:

```bash
cd apps/api && npx jest src/order-templates/ src/recurring-invoices/ src/invoices/invoices.service src/buyer/ src/orders/orders.service src/orders/orders.scan-hardening src/common/no-bare-cron src/auth/google-oauth.removed-customer src/authorizations/authorization-expiry src/routes/ --reporters=default
cd apps/web && npx jest lib/buyer-auth-context app/buyer
```

---

## Mutation probes (fix-revert)

| File                                                            | revertFix | REG test that must go red |
| --------------------------------------------------------------- | --------- | ------------------------- |
| `apps/api/src/order-templates/order-templates.service.ts`       | true      | REG-B131 T1               |
| `apps/api/src/recurring-invoices/recurring-invoices.service.ts` | true      | REG-B131 T2 (and T3)      |
| `apps/api/src/invoices/invoices.service.ts`                     | true      | REG-B131 T4 (and T5)      |
| `apps/api/src/buyer/guards/buyer-seller-context.guard.ts`       | true      | REG-B141 T6 (and T7)      |
| `apps/api/src/buyer/buyer.service.ts`                           | true      | REG-B141 T8               |

Probe commands are the two red-gate commands above, scoped to the file's REG token.

---

## Sibling notes (record, do NOT fix in this run)

- **Duplicated portal-link logic (L-072 drift risk):** `disconnectPortal` / `getPortalStatus` / `approveBuyerRequest`
  are near-verbatim twins between `customers.service.ts` ~2693-2711 and `buyer.service.ts` ~362-386, and
  `disconnectPortal` is not tx-aware. File as a separate refactor row. It is not this defect's shape.
- **`customers.service.ts` ~2735 `approveBuyerRequest` (follow-up row, review round 1):** it reads
  `customerLink.findFirst({ where: { customerId, tenantId } })` with no `customer: { deletedAt: null }` and then writes
  `status: "ACTIVE"`, so a seller (or an operator working an old bell notification) can still flip a **removed** customer's
  link ACTIVE. The guard then refuses every seller-scoped route for that buyer, so the portal is dead either way — but the
  write is not restore-symmetric, which is why R6's wording is now qualified to the fixed paths. `customers.service.ts` is
  outside this run's fence; file as a follow-up row.
- **`customers.service.ts` ~2780 `listPendingPortalApprovals` (follow-up row, review round 1):** lists pending portal
  requests without filtering `customer.deletedAt`, so a request raised before removal still appears in the seller's
  approval queue for a customer they deleted. Cosmetic on its own; it is the UI that leads to the write above. Same
  follow-up row.
- **`google-oauth.service.ts` ~615 (fixed in review round 2):** `sellerCount` in the Google sign-in response now carries
  the same `customer: { deletedAt: null }` filter as `BuyerService.getSellers`, so a removed seller no longer counts
  toward the mobile "connected to a supplier" branch. See the round-2 fence amendment above.
- **Manual order-template "generate now"** (`generateOrder` ~253 / `generateOrderForUser` ~290) for a removed customer's
  template is staff-initiated and not a cron. It is outside the owner's three sites. Candidate follow-up row.
- **`createInvoiceFromOrder`** for an order placed before removal is untouched on purpose: invoicing already-delivered work
  is legitimate receivables.
- **`OrdersService.create` (recorded + fixed in review, `orders.service.ts` ~1717/1735):** `createInvoiceFromOrder`'s
  allowance covers only orders placed **before** removal; `OrdersService.create` now refuses a removed customer on the
  staff and driver branches (`customer.deletedAt` → the existing `BadRequestException("Customer not found")`), so no new
  post-removal order can be created and then invoiced. The customer-role branch, idempotency, advisory locks and
  auto-merge are untouched. Covered by two `REG-B131` specs in `orders.service.spec.ts`.
- **`estimates.service.ts` `create()` ~45-49:** reads
  `forTenant().customer.findUnique({ where: { id: dto.customerId } })` and rejects only `!customer` — no
  `deletedAt` check, unlike the fixed `InvoicesService.create`, so an estimate can still be raised for a
  removed customer. Candidate follow-up row.
- **`estimates.service.ts` `convertToInvoice` ~257-345 — owner ruling needed.** It mints the invoice
  itself at ~307 (`tx.invoice.create({ data: { customerId: est.customerId, ... } })`), never reads
  `Customer` and never calls `InvoicesService.create`, so R3's 404 does not apply — R3's coverage is
  `InvoicesService.create` only. The estimate stays listed (`findAll` ~183-201 has no
  `customer.deletedAt` filter), so Convert is normal-UI reachable. **Ruling:** is converting a
  pre-removal ACCEPTED estimate legitimate receivables (like `createInvoiceFromOrder`), or must it 404
  like `create()`? If it must 404, the check belongs on the estimate's customer row inside
  `convertToInvoice` **ahead of** `numbering.reserveNext("INVOICE")` (~279), so no invoice number is
  burned.
- **`credit-notes.service.ts` ~310:** `customer.findFirst({ where: { id: dto.customerId }, select: {
id, businessName } })` + `if (!customer) throw` — the same unfiltered customer read, so a credit
  note can still be issued against a removed customer. Candidate follow-up row.
- **`import.service.ts` ~941:** the CSV invoice importer writes invoices directly
  (`forTenant().invoice.create({ data: { customerId: customer.id, ... } })`) and resolves the customer
  by name at ~598 (`businessName: { contains: customerName, mode: "insensitive" }`) with no
  `deletedAt` filter, so an import row can attach a new invoice to a removed customer (which also
  suppresses the auto-create branch). Read-only verification; not exercised. Candidate follow-up row.
- **Recurring "generate now"** for a removed customer now fails at `invoicesService.create` with 404 "Customer not
  found". `generateInvoiceFromTemplate`'s existing failure path (REG-B106) records the FAILED outcome and gives the cycle
  back. That is the intended behavior, not a regression.
- **Latent, pre-existing (cause-refutation §5):** hard-deleting a linked customer would hit the `CustomerLink.customerId` FK.
  Out of train scope.
- Sweep result at master (gather pass): 37 `isActive: true` hits in `apps/api/src/**/*.service.ts`, and only the two fixed
  crons are customer-owned schedules. Of 27 `customerLink` reads, only the guard is a per-request buyer authorization gate.

---

## Data repair (S3.6): reports only, no backfill in this run

The owner approved running read-only reports during train 4. Each proposed report is SELECT-only, opens its session
with `SET default_transaction_read_only = on` (pattern: `apps/api/scripts/prod-readonly-audit.mjs` ~64), runs via
`railway run --service postgres node <script>`, and prints counts per tenant plus row ids only. It prints no business
names, slugs or emails, and its output stays in gitignored `local-assets/`. None is written in this run.

| Bug  | Prod rows possibly corrupted?                                                                                                                               | Read-only report that would measure it (NOT written in this run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B131 | **Plausibly yes.** Every removed customer with an active template or a due recurring invoice kept getting orders and invoices; `autoSend` ones were emailed | proposed `apps/api/scripts/report-b131-removed-customer-generation.mjs`: (a) `"Order"` rows with `"templateId" IS NOT NULL` joined to `"Customer"` where `c."deletedAt" IS NOT NULL AND o."createdAt" > c."deletedAt"`; (b) `"Invoice"` rows with `"recurringInvoiceId" IS NOT NULL` under the same join, with a separate count of `"sentAt" IS NOT NULL` (emailed); (c) manual invoices (`"recurringInvoiceId" IS NULL AND "orderId" IS NULL`) created after `deletedAt`. Caveat: a customer removed and later restored has `deletedAt = NULL` now, so its window is invisible and the report undercounts. Say so in the output |
| B141 | **Plausibly yes.** A removed customer's buyer could still place orders, pay, and read statements                                                            | proposed `apps/api/scripts/report-b141-post-removal-buyer-activity.mjs`: orders for customers with `deletedAt IS NOT NULL` that have an `ACTIVE` `"CustomerLink"`, created after `deletedAt` with `"templateId" IS NULL`. `Order.source` (`APP`/`PHONE`/`ROUTE`) does not identify a buyer-portal order, so confirm the buyer-origin marker (creator/audit row) when writing the script; include buyer payment requests if a column ties them to the customer                                                                                                                                                                    |

The owner decides any repair after reading a report, with a fresh backup, via a dry-run-first script, and never on a
live client tenant without an explicit request.

---

## Risks & rollback

| Risk                                                                                                                | Likelihood | Blast radius                                               | Mitigation / reviewer watch                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guard filter wrongly refuses LIVE buyers (e.g. the relation filter reads zero customer rows in the guard's context) | low        | tenancy/auth: every buyer locked out of a seller           | `Customer` has no RLS, and the guard already `include`s the same relation from the same client. P4 pins the live path. Post-deploy: watch 403 `"No active connection to this seller"` rates on `/buyer/*`                                                                          |
| Run A also edits `invoices.service.ts` (`deleteInvoice` ~5323), and both runs ship in one window                    | med        | merge conflict only                                        | Regions are ~5000 lines apart. Land serially; rebase whichever lands second, then re-run its red-gate and final commands. Do not resolve by hand across the two hunks                                                                                                              |
| Engine "improves" scope: token revocation, `isActive` writes, touching `disconnectPortal`                           | med        | a buyer logged out of every wholesaler / restore asymmetry | Out of scope by owner ruling. Any such hunk is a blocker, not a note                                                                                                                                                                                                               |
| A describe title containing `REG-` pulls pins into the red gate                                                     | low        | red gate falsely green or red                              | Titles fixed above; the reviewer checks                                                                                                                                                                                                                                            |
| Buyer web/mobile shows a raw 403 after removal                                                                      | med        | UX only                                                    | The existing message is reused and already handled for DISCONNECTED links. **Fixed on web in review round 2** (`buyer-auth-context.tsx` reconcile), pinned by W1-W3 (mount / refresh-token paths) and W4/W5 (`refreshSellers`). Mobile is still unverified and remains a follow-up |
| P3 (fixture control) red on the untouched tree                                                                      | low        | a T4/T5 false red                                          | Harness note: complete the fixture from the RF-1 test; never weaken T4/T5                                                                                                                                                                                                          |

- **Rollback:** revert the squash commit. There is no schema, no flag and no data write.
- **Migration reversibility:** none needed (no migration).
- **Feature flag / entitlement:** none.
- **Deploy day:** existing rows are untouched. A removed customer's next 06:00 template tick and 00:00 recurring tick skip
  them. Their buyer's next seller-scoped request gets a 403 and the seller leaves their switcher. Restore (Undo, or the
  restore endpoint) reverses all of it immediately.
- **Observability:** the cron summary logs (`Daily order generation complete: N created, N skipped, N suppressed
(customer removed) across N tenant(s)`, `Recurring invoices: N generated, N failed, N suppressed (customer removed)
across N tenant(s).`) surface the removed customers' share as the new `suppressed` count; watch 403 `"No active
connection to this seller"` on `/api/v1/buyer/*`.

---

## Pipeline args

The launcher copies `pipeline-args.json` (beside this file) verbatim. The launcher fixes `2026-09-1X` to the launch date
and adds `startedAt`/`workdir`. There are no `specPath`/`discoveryPath` (bugfix mode; this plan plus the cause ruling
stand in).

```json
{
  "mode": "bugfix",
  "planPath": ".claude/pipeline/2026-09-10-train4-run-d/build-plan.md",
  "testPlanPath": ".claude/pipeline/2026-09-10-train4-run-d/bug-test-plan.md",
  "lessonsPath": ".claude/lessons/LESSONS.md",
  "scale": "major",
  "context": "Train 4 Run D: B131 removed customer's crons keep firing (stateless customer.deletedAt filter, create() 404s); B141 removed customer keeps portal access (guard refuses, getSellers hides, NO token revocation). S4/S5 by Opus 5 (Fable 429).",
  "radiusFiles": [
    "apps/api/src/order-templates/order-templates.service.ts",
    "apps/api/src/recurring-invoices/recurring-invoices.service.ts",
    "apps/api/src/invoices/invoices.service.ts",
    "apps/api/src/buyer/guards/buyer-seller-context.guard.ts",
    "apps/api/src/buyer/buyer.service.ts",
    "apps/api/src/customers/customers.service.ts",
    "apps/api/src/buyer/buyer.controller.ts",
    "apps/api/src/payment-requests/buyer-payments.controller.ts"
  ],
  "siblingPatterns": [
    {
      "regex": "customerLink\\.(findFirst|findMany|count)\\(",
      "note": "buyer link read w/o customer.deletedAt; see build-plan Sibling notes"
    },
    {
      "regex": "isActive: true, (daysOfWeek|nextRunAt)",
      "note": "customer-owned crons; only the 2 fixed hits expected"
    }
  ],
  "testPackages": [
    {
      "id": "TP1",
      "title": "B131 tests",
      "files": [
        "apps/api/src/order-templates/order-templates.removed-customer.spec.ts",
        "apps/api/src/recurring-invoices/recurring-invoices.service.spec.ts",
        "apps/api/src/invoices/invoices.service.spec.ts"
      ],
      "brief": "build-plan.md TP1 exact code"
    },
    {
      "id": "TP2",
      "title": "B141 tests",
      "files": [
        "apps/api/src/buyer/guards/buyer-seller-context.guard.spec.ts",
        "apps/api/src/buyer/buyer-connect.spec.ts"
      ],
      "brief": "build-plan.md TP2 exact code"
    }
  ],
  "redGate": {
    "commands": [
      "cd apps/api && npx jest src/order-templates/order-templates.removed-customer src/recurring-invoices/recurring-invoices.service src/invoices/invoices.service -t \"REG-B131\" --reporters=default",
      "cd apps/api && npx jest src/buyer/guards/buyer-seller-context.guard src/buyer/buyer-connect -t \"REG-B141\" --reporters=default"
    ],
    "expect": "fail"
  },
  "packages": [
    {
      "id": "WP1",
      "title": "B131 filters",
      "files": [
        "apps/api/src/order-templates/order-templates.service.ts",
        "apps/api/src/recurring-invoices/recurring-invoices.service.ts",
        "apps/api/src/invoices/invoices.service.ts"
      ],
      "brief": "build-plan.md WP1 exact code",
      "effort": "high",
      "provenBy": ["T1", "T2", "T3", "T4", "T5"]
    },
    {
      "id": "WP2",
      "title": "B141 guard+getSellers",
      "files": [
        "apps/api/src/buyer/guards/buyer-seller-context.guard.ts",
        "apps/api/src/buyer/buyer.service.ts"
      ],
      "brief": "build-plan.md WP2 exact code",
      "effort": "high",
      "provenBy": ["T6", "T7", "T8"]
    }
  ],
  "verifyCommands": {
    "perRound": [
      "npm run check-types -w apps/api",
      "npm run lint -w apps/api",
      "npm run check-types -w apps/web"
    ],
    "final": [
      "cd apps/api && npx jest src/order-templates/ src/recurring-invoices/ src/invoices/invoices.service src/buyer/ src/orders/orders.service src/orders/orders.scan-hardening src/common/no-bare-cron src/auth/google-oauth.removed-customer src/authorizations/authorization-expiry src/routes/ --reporters=default",
      "cd apps/web && npx jest lib/buyer-auth-context app/buyer"
    ]
  },
  "mutationProbe": {
    "targets": [
      {
        "file": "apps/api/src/order-templates/order-templates.service.ts",
        "revertFix": true,
        "behavior": "skip removed",
        "test": "REG-B131 T1"
      },
      {
        "file": "apps/api/src/recurring-invoices/recurring-invoices.service.ts",
        "revertFix": true,
        "behavior": "skip removed",
        "test": "REG-B131 T2"
      },
      {
        "file": "apps/api/src/invoices/invoices.service.ts",
        "revertFix": true,
        "behavior": "404 removed",
        "test": "REG-B131 T4"
      },
      {
        "file": "apps/api/src/buyer/guards/buyer-seller-context.guard.ts",
        "revertFix": true,
        "behavior": "refuse removed",
        "test": "REG-B141 T6"
      },
      {
        "file": "apps/api/src/buyer/buyer.service.ts",
        "revertFix": true,
        "behavior": "hide removed",
        "test": "REG-B141 T8"
      }
    ]
  }
}
```

> Amended 2026-09-10 (lead): --reporters=default moved LAST — Jest reads positionals after it as reporter modules (proven in wf_363f0377-624 Baseline).

This block and `pipeline-args.json` are the same object. Size, measured not estimated: the committed file was **4,463
bytes** after prettier, and **4,580 bytes** once the round-3 verify command above was extended. That is past 4 KB and
close to the ~4.5 KB ceiling where a Workflow **resume** reads the stored args back truncated and dies with
`workflow.js:260 Expected }` (reference `reference_workflow_resume_args_truncation_2026-09-05`) — so any further growth
goes into a referenced file, not into this object. The test files are left out of `radiusFiles` for the same reason; the
engine reviews them as part of the diff anyway.

## Follow-ups filed at bookkeeping

Found in the round-2 fix pass; both are out of scope for this diff (neither is a wrong value a user can
observe), so they land as register/bookkeeping items rather than code here.

- **(a) `routes.service.ts` createRun — the suppressed count and the include filter disagree on tenancy.**
  The count runs through `forTenant()`, so Prisma injects `tenantId`; the nested `include.stops.where`
  that actually drops removed-customer stops does not carry it. A legacy NULL-tenant `RouteStop` row is
  therefore dropped from the dispatch but never counted, so the `REG-B131` warn can understate what it
  skipped. Log-only — no stop is wrongly dispatched and no money moves — and NULL-tenant rows are the
  owner's structural-backfill project, not this fix's radius.
- **(b) `sendPortalInvite` still mints a token for a removed customer.** The invite is dead on arrival:
  all three redemption doors (`acceptInvite`, Google sign-in's invite redemption, and the buyer-connect
  request) now fence on `customer.deletedAt: null`, so the token can never be spent. What remains is a
  UX wart — an operator gets a "sent" confirmation for an invite nobody can ever use — not a security
  or correctness hole. Fix belongs with the customers-module UX pass, where the refusal message can be
  written once for the whole removed-customer surface.
