# Build plan — F14 v2: authorization / tenancy matrix

**Branch** `fix/F14-authz-matrix-v2` · **worktree** `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14`
(referred to below as `W/`) · base master `39632d27`. Rows **B52 B132 B133 B138 B155 B165 B168**.
Companions in this directory: [spec.md](./spec.md) (R1–R17) and [test-plan.md](./test-plan.md)
(T1–T25). This document is the HOW and is standalone — every fact an implementer needs is written
here; where it says "verified" it means re-read from the worktree source at `39632d27`.

Risk class **HIGH on every package** — auth, tenancy, PII. Every line of code below was derived
from the source in `W/`; if a file disagrees with a line quoted here, **the file wins and you
report the divergence** (L-026) — do not quietly conform or quietly diverge.

---

## 0. Ground rules that bind every package

1. **Layers.** API (`W/apps/api`) and web (`W/apps/web`) plus the approved-tenant seed script
   `W/apps/api/scripts/e2e-seed.js`. **No mobile file. No schema change. No migration**
   (`AuditLog.impersonatedBy` is live since migration `20260908000000`, F01). Commit title names
   both layers (L-008).
2. **Tiers.** T1 = jest in `apps/api`. T2 = web-side: `apps/web` has NO unit runner (campaign
   decision D1), so a web proof is a Playwright spec that runs POST-deploy from the deploy signal.
   **Never run Playwright locally — not even `npx playwright test --list`** — it overwrites
   `.campaign/runs/web-e2e.json`. The two e2e specs are typechecked only (`tsc --noEmit` in
   `apps/web` includes `e2e/**/*.ts`).
3. **Test titles.** Every T1 proof title carries the EXACT token `REG-B<id>` (matched by
   `/REG-B(\d{2,3})(?![0-9])/`). **Pins** — tests that are green BEFORE the fix by design — carry
   NO `REG-B` token; title them `pin (B<id>): …`. The red gate filters on `-t "REG-B(...)"`, so
   pins stay in the same files but outside the red-gate scope. The pins are: T4 (SUPER_ADMIN
   exemption), T6 (11-prefix owner coverage table), T8's operator/TENANT_ADMIN cases, T9's
   `findAll/findOne` no-roles case, T11's owner/operator cases, T13 (inventory reads keep DRIVER),
   T14's absent-claim cases, T17's no-log cases, T18's unimpersonated case, T19's race + inactive
   cases. Everything else is a REG- proof and MUST fail on an ASSERTION against `39632d27`.
4. **Compile-time reds are not reds** (except where noted). New symbols the fix introduces
   (`addItemForUser`, the 3-arg `addItem`) are reached through `as any` casts in the tests so the
   unfixed tree fails on an assertion (`TypeError: … is not a function` rejected instead of
   `ForbiddenException`), not on a ts-jest diagnostic that would also kill every sibling test in
   the file.
5. **Conventions.** `Test.createTestingModule` where a module is needed; reflection specs and
   controller-instance specs need none (precedent: `customers.controller.roles.spec.ts`,
   `auth.controller.cookie.spec.ts`). `createMockPrisma()` from `src/testing/prisma-mock.ts`
   (defaults: `findUnique → null`, `updateMany → { count: 0 }`, `deleteMany → { count: 0 }`,
   `upsert → {}`; it HAS `auditLog`, `orderTemplate`, `orderTemplateItem`, `refreshToken`,
   `customerPrice`). Prettier: semicolons, double quotes, printWidth 100, trailing commas.
   **No snapshot tests, no Vitest.**
6. **Running jest.** `W/apps/api` has no local `node_modules/.bin` — the binary is at the root.
   Always run through npm with an absolute prefix so the cwd is right regardless of the shell:
   `npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api test -- <paths> [-t <regex>]`.
   The jest reporter writes `.campaign/runs/api.json` on EVERY run — a scoped run leaves a scoped
   artifact (L-034); the final gate re-runs the full `apps/api` suite so the artifact is whole.
7. **Do not run `npm run verify`** here — its last step (`campaign-check`) reads run artifacts a
   fresh worktree lacks. The scoped commands in §5 are the gates.
8. **Order inside the batch** (card + SEQUENCE §2): B52 → B165 → B138 → B155 → B168 → B132 →
   B133 (B133 last — F13 shares `order-templates.service.ts`). R8 (the `jwt.strategy.ts`
   whitelist) is edited ONCE, in WP2, and precedes WP3 logically; they share no file.

---

## 1. Test packages (written FIRST; must be red against `39632d27`)

Red-gate command (runs ONLY the REG- proofs in these files; expect a non-zero exit):

```
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api test -- src/uploads/uploads-tenant-scope.security.spec.ts src/customers/customers.controller.roles.spec.ts src/customers/customers.service.spec.ts src/order-templates/order-templates.controller.roles.spec.ts src/order-templates/order-templates.service.spec.ts src/inventory/inventory.controller.roles.spec.ts src/auth/strategies/jwt.strategy.spec.ts src/audit/audit.interceptor.security.spec.ts src/audit/audit.service.spec.ts src/auth/guards/impersonation.guard.spec.ts src/auth/auth.controller.cookie.spec.ts src/auth/auth.service.spec.ts -t "REG-B(52|132|133|138|155|165|168)"
```

### TP1 — uploads (B52) · T1–T6 · R1 R2

**Files**

- `W/apps/api/src/uploads/uploads-tenant-scope.security.spec.ts` (extend)
- `W/apps/api/src/uploads/uploads-xss.security.spec.ts` (guard stub only — collateral, see below)

**Harness facts (verified).** The spec builds a Nest app with `UploadsController`, a
`ConfigService` stub returning `tmpDir` for `uploadDir`, `PrismaService: prismaMock` (a plain
object of model stubs, NOT `createMockPrisma`), and overrides `UploadsAccessGuard` with a stub
that sets `req.user = { tenantId: <x-test-tenant>, role: <x-test-role ?? "OPERATOR"> }` and
`req.signedUrlAuthorized = true` only when `x-test-signed` is present. Helper
`get(key, tenant?, role?, signed?)`. Fixtures are written by `write(key)` in `beforeAll`.

**Add to `prismaMock`** (beside `invoice`):

```ts
    supplierStatementScan: {
      findUnique: jest.fn(({ where: { id } }) => Promise.resolve(scans[id] ?? null)),
    },
```

with, beside `owners`:

```ts
// B52: supplier-statement scans are keyed `supplier-statements/<scanId>/<n>.<ext>`.
// `ssNull` mirrors a legacy row whose tenantId was never injected (the column is nullable).
const scans: Record<string, { tenantId: string | null } | undefined> = {
  ss1: { tenantId: "t1" },
  ssNull: { tenantId: null },
};
```

**Add to `beforeAll` fixtures:**

```ts
write("supplier-statements/ss1/1.txt");
write("supplier-statements/missing/1.txt");
write("supplier-statements/ssNull/1.txt");
write("legacy-prefix/x/file.txt");
write("flat.txt");
```

**Tests** (new `describe("B52 — supplier-statements owner gate + JWT-path default-deny", …)`
at the end of the file; `import * as fs from "fs"` is already there):

- `REG-B52 a JWT caller in another tenant cannot read a supplier-statement scan (403 + the owner lookup ran)`
  — `prismaMock.supplierStatementScan.findUnique.mockClear()`; `get("supplier-statements/ss1/1.txt", "t2")`
  → `status 403`, `body.message === "Cross-tenant file access denied"`, and
  `findUnique` called with `{ where: { id: "ss1" }, select: { tenantId: true } }`. (The call
  assertion is what makes T1 discriminate from the default-deny — a deny never touches Prisma.)
- `REG-B52 the owning tenant reads its supplier-statement scan (200) through the owner lookup`
  — `mockClear()`; `get(…, "t1")` → 200, `text` equals the fixture bytes `"net,sales\n1,2\n"`,
  AND `findUnique` called once with `id: "ss1"`. (Red pre-fix: no lookup exists → not called.)
- `REG-B52 a missing or NULL-tenant scan row fails closed (403, never 404)` —
  `get("supplier-statements/missing/1.txt", "t1")` → 403; `get("supplier-statements/ssNull/1.txt", "t1")` → 403.
- `pin (B52): SUPER_ADMIN reads a supplier-statement scan and an unmapped prefix alike` —
  `get("supplier-statements/ss1/1.txt", undefined, "SUPER_ADMIN")` → 200;
  `get("legacy-prefix/x/file.txt", undefined, "SUPER_ADMIN")` → 200.
- `REG-B52 unmapped prefixes and flat keys are denied on the JWT path BEFORE the filesystem check; signed URLs stay exempt`
  — install `const existsSpy = jest.spyOn(fs, "existsSync");` in a `beforeEach` of this describe
  (`afterEach: existsSpy.mockRestore()`), then:
  `get("legacy-prefix/x/file.txt", "t1")` → 403 and `existsSpy` **not called**;
  `get("flat.txt", "t1")` → 403; `get("legacy-prefix/nope/absent.txt", "t1")` → 403 (not written; a
  404 would prove the deny ran after fs); `get("legacy-prefix/x/file.txt", "t1", undefined, true)` → 200.
  Positive control for the spy: `existsSpy.mockClear(); get("supplier-statements/ss1/1.txt", "t1")`
  → `existsSpy` called once (proves the spy observes the real path).
- `pin (B52): every live storage prefix is readable by its owner (coverage table)` —
  `it.each` over the LITERAL list `["expenses/e1/receipt.txt", "statement-pdfs/c1/2026-01.pdf", "customers/c1/documents/doc.txt", "invoice-pdfs/inv1.pdf", "payments/pay1/receipt.txt", "products/p1/img.txt", "supplier-statements/ss1/1.txt", "tenants/t1/doc.txt", "invoice-scans/scan1/scan.txt", "regulated-filings/t1/cat/2026-01.csv", "tobacco-reports/t1/2026-01.csv"]`
  → each 200 as `t1`. The list is the source sweep (11 distinct prefixes at `39632d27`), not
  derived from the controller.

**Collateral (keeps an existing suite green after R2).** `uploads-xss.security.spec.ts` serves
flat keys (`foo.png`, `doc.pdf`, `evil.svg`) with the guard stubbed as `canActivate: () => true`
and no caller — under the default-deny those would 403. It tests response headers, not auth, so
its stub must take the signed-URL path. Replace BOTH occurrences (lines ~233 and ~296) of

```ts
      .useValue({ canActivate: () => true })
```

with

```ts
      .useValue({
        canActivate: (ctx: any) => {
          // Signed-URL path: B52's JWT-path default-deny (unknown/flat keys → 403)
          // must not fire here — this suite tests response headers, not auth.
          ctx.switchToHttp().getRequest().signedUrlAuthorized = true;
          return true;
        },
      })
```

`uploads-signed-url.security.spec.ts` needs no change (its "missing signature" case expects a 4xx).

### TP2 — DRIVER grants (B132 B133 B168) · T7–T13 · R3–R7

**Files**

- `W/apps/api/src/customers/customers.controller.roles.spec.ts` (extend)
- `W/apps/api/src/customers/customers.service.spec.ts` (extend + INVERT one test)
- `W/apps/api/src/order-templates/order-templates.controller.roles.spec.ts` (NEW)
- `W/apps/api/src/order-templates/order-templates.service.spec.ts` (extend)
- `W/apps/api/src/inventory/inventory.controller.roles.spec.ts` (NEW)

**T7** — append to `customers.controller.roles.spec.ts`:

```ts
it("REG-B132 upsertCustomerPrice declares the same roles as deleteCustomerPrice and admits no DRIVER", () => {
  const proto = CustomersController.prototype as Record<string, any>;
  expect(typeof proto.upsertCustomerPrice).toBe("function");
  expect(typeof proto.deleteCustomerPrice).toBe("function");
  const post = reflector.get<UserRole[]>(ROLES_KEY, proto.upsertCustomerPrice);
  const del = reflector.get<UserRole[]>(ROLES_KEY, proto.deleteCustomerPrice);
  expect(Array.isArray(post) && post.length > 0).toBe(true);
  expect(post).not.toContain(UserRole.DRIVER);
  expect([...post].sort()).toEqual([...del].sort());
});
```

**T8** — in `customers.service.spec.ts` `describe("upsertCustomerPrice")` (line ~1171;
`operatorPayload` at :35, `driverPayload` at :1172):

1. INVERT the test at :1222 `"a DRIVER may still null the tier on a row that keeps its MSRP (no delete involved)"`
   — it asserts the bug. New title and body:

```ts
it("REG-B132 a DRIVER cannot null the tier even on a row that keeps its MSRP — refused before any read", async () => {
  prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 });

  const err = await service
    .upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: null }, driverPayload)
    .catch((e) => e);

  expect(err).toBeInstanceOf(ForbiddenException);
  expect(String(err.message)).toMatch(/^Only operators/);
  expect(prisma.customerPrice.findUnique).not.toHaveBeenCalled();
  expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
  expect(prisma.customerPrice.delete).not.toHaveBeenCalled();
});
```

2. Add:

```ts
it("REG-B132 a DRIVER posting a tier is refused before the MSRP entitlement or any DB read", async () => {
  const msrpSpy = jest.spyOn(service as any, "assertMsrpAllowed");
  prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 });

  const err = await service
    .upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: 4, msrp: 7 }, driverPayload)
    .catch((e) => e);

  expect(err).toBeInstanceOf(ForbiddenException);
  expect(String(err.message)).toMatch(/^Only operators/);
  expect(msrpSpy).not.toHaveBeenCalled();
  expect(prisma.customerPrice.findUnique).not.toHaveBeenCalled();
  expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
});

it("REG-B132 an undefined user is refused (no caller identity → no override change)", async () => {
  const err = await service
    .upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: 4 }, undefined as any)
    .catch((e) => e);
  expect(err).toBeInstanceOf(ForbiddenException);
  expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
});

it("pin (B132): OPERATOR and TENANT_ADMIN still upsert (partial update preserved)", async () => {
  prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 });
  prisma.customerPrice.upsert.mockResolvedValue({ id: "cp-1" });
  await service.upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: 4 }, operatorPayload);
  await service.upsertCustomerPrice(
    "cust-1",
    { productId: "p1", pricingTier: 4 },
    { ...operatorPayload, role: "TENANT_ADMIN" as const },
  );
  expect(prisma.customerPrice.upsert).toHaveBeenCalledTimes(2);
  expect(prisma.customerPrice.upsert).toHaveBeenLastCalledWith(
    expect.objectContaining({ update: expect.objectContaining({ pricingTier: 4, msrp: 5 }) }),
  );
});
```

(The existing `:1215` test "a DRIVER cannot use {pricingTier: null} as a delete primitive" stays
as-is — it asserts only the exception class and `delete` not called, both still true.)

**T9 + T10** — NEW `order-templates.controller.roles.spec.ts`:

```ts
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { OrderTemplatesController } from "./order-templates.controller";

/**
 * B133: four standing-order mutations still admitted DRIVER after the driver
 * screens that motivated the grant were deleted (028f86b0). generateDailyOrders
 * (06:00 cron) materialises whatever a driver wrote into billed orders.
 */
describe("OrderTemplatesController @Roles matrix (B133)", () => {
  const reflector = new Reflector();
  const proto = OrderTemplatesController.prototype as Record<string, any>;
  const rolesOf = (h: string) => {
    expect(typeof proto[h]).toBe("function");
    return reflector.get<UserRole[]>(ROLES_KEY, proto[h]);
  };

  it("REG-B133 every mutation declares roles and none admits DRIVER", () => {
    for (const h of ["create", "update", "remove", "addItem", "removeItem", "generateOrder"]) {
      const roles = rolesOf(h);
      expect({ h, declared: Array.isArray(roles) && roles.length > 0 }).toEqual({
        h,
        declared: true,
      });
      expect({ h, roles }).toEqual({ h, roles: expect.not.arrayContaining([UserRole.DRIVER]) });
    }
  });

  it("REG-B133 the matrix is {OPERATOR, CUSTOMER} for owner-scoped mutations and [OPERATOR] for addItem", () => {
    for (const h of ["create", "update", "remove", "removeItem", "generateOrder"]) {
      expect([...rolesOf(h)].sort()).toEqual([UserRole.CUSTOMER, UserRole.OPERATOR].sort());
    }
    expect(rolesOf("addItem")).toEqual([UserRole.OPERATOR]);
  });

  it("pin (B133): findAll/findOne carry no @Roles (recorded residual — a DRIVER can still list)", () => {
    expect(reflector.get(ROLES_KEY, proto.findAll)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, proto.findOne)).toBeUndefined();
  });

  it("REG-B133 addItem delegates to the ownership wrapper addItemForUser, never to addItem", async () => {
    const svc = { addItemForUser: jest.fn().mockResolvedValue("ok"), addItem: jest.fn() };
    const ctrl = new OrderTemplatesController(svc as any) as any;
    const dto = { productId: "p1", qty: 2 };
    const user = { sub: "u1", role: "OPERATOR" };

    const result = await ctrl.addItem("t1", dto, user);

    expect(result).toBe("ok");
    expect(svc.addItemForUser).toHaveBeenCalledWith("t1", dto, user);
    expect(svc.addItem).not.toHaveBeenCalled();
  });
});
```

**T11** — append inside `describe("OrderTemplatesService — template ownership (F2-003)")` in
`order-templates.service.spec.ts` (fixtures `template` owner `c-owner`, `asCustomer`, `asOperator`
exist; `prisma.orderTemplate.findUnique → template` is primed in `beforeEach`):

```ts
it("REG-B133 a CUSTOMER who does not own the template cannot add items to it", async () => {
  prisma.customer.findFirst.mockResolvedValue({ id: "c-attacker" });
  prisma.product.findUnique.mockResolvedValue({ id: "p1" });

  const err = await (service as any)
    .addItemForUser("t1", { productId: "p1", qty: 1 }, asCustomer("u-attacker"))
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(ForbiddenException);
  expect(prisma.orderTemplateItem.create).not.toHaveBeenCalled();
});

it("REG-B133 a CUSTOMER JWT with no customer record cannot add items (cross-tenant token)", async () => {
  prisma.customer.findFirst.mockResolvedValue(null);
  const err = await (service as any)
    .addItemForUser("t1", { productId: "p1", qty: 1 }, asCustomer("u-foreign"))
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ForbiddenException);
  expect(prisma.orderTemplateItem.create).not.toHaveBeenCalled();
});

it("pin (B133): the owning customer and an operator add items; the operator path skips the ownership read", async () => {
  prisma.product.findUnique.mockResolvedValue({ id: "p1" });
  prisma.orderTemplateItem.create.mockResolvedValue({ id: "i2" });

  prisma.customer.findFirst.mockResolvedValue({ id: "c-owner" });
  await (service as any).addItemForUser("t1", { productId: "p1", qty: 1 }, asCustomer("u-owner"));
  expect(prisma.orderTemplateItem.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ templateId: "t1", productId: "p1", qty: 1 }),
    }),
  );

  prisma.customer.findFirst.mockClear();
  await (service as any).addItemForUser("t1", { productId: "p1", qty: 1 }, asOperator);
  expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  expect(prisma.orderTemplateItem.create).toHaveBeenCalledTimes(2);
});
```

(Note: on `39632d27` `addItemForUser` does not exist — `(service as any).addItemForUser(...)`
throws `TypeError` synchronously; wrap as `Promise.resolve().then(() => (service as any).addItemForUser(...)).catch(...)`
if the bare call throws before `.catch` attaches. Either way the REG tests fail on
`toBeInstanceOf(ForbiddenException)`, not on compilation.)

**T12 + T13** — NEW `inventory.controller.roles.spec.ts`:

```ts
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { InventoryController } from "./inventory.controller";

/**
 * B168: RolesGuard resolves `getAllAndOverride(handler, class)`, so a handler-level
 * @Roles(OPERATOR, DRIVER) OVERRIDES the class-level @Roles(OPERATOR). Four writes
 * carried that override after the driver PO/inventory screens were deleted.
 */
describe("InventoryController effective @Roles (B168)", () => {
  const reflector = new Reflector();
  const proto = InventoryController.prototype as Record<string, any>;
  const effective = (h: string) => {
    expect(typeof proto[h]).toBe("function");
    return reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [proto[h], InventoryController]);
  };

  it("REG-B168 every inventory write resolves to exactly [OPERATOR] — no DRIVER", () => {
    for (const h of [
      "recordPurchase",
      "recordAdjustment",
      "createPO",
      "receivePO",
      "commitStockCount",
      "sendPO",
      "closePO",
    ]) {
      expect({ h, roles: effective(h) }).toEqual({ h, roles: [UserRole.OPERATOR] });
    }
  });

  it("pin (B168): the four inventory reads still admit DRIVER (scope fence — reads are out of scope)", () => {
    for (const h of ["getStockOverview", "listMovements", "listPOs", "getPO"]) {
      expect(effective(h)).toEqual(expect.arrayContaining([UserRole.OPERATOR, UserRole.DRIVER]));
    }
  });
});
```

### TP3 — impersonation identity (B165 B138-API) · T14–T18 · R8–R11

**Files**

- `W/apps/api/src/auth/strategies/jwt.strategy.spec.ts` (NEW)
- `W/apps/api/src/audit/audit.interceptor.security.spec.ts` (extend)
- `W/apps/api/src/audit/audit.service.spec.ts` (NEW)
- `W/apps/api/src/auth/guards/impersonation.guard.spec.ts` (NEW)
- `W/apps/api/src/auth/auth.controller.cookie.spec.ts` (extend)

**T14** — `jwt.strategy.spec.ts`:

```ts
import { JwtStrategy } from "./jwt.strategy";
import { BuyerJwtStrategy } from "../../buyer/strategies/buyer-jwt.strategy";

const configService = { get: () => ({ secret: "test-secret" }) } as any;

const staffPayload = {
  sub: "ta1",
  username: "tenant_admin",
  role: "TENANT_ADMIN",
  status: "ACTIVE",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
} as any;

describe("JwtStrategy / BuyerJwtStrategy — impersonatedBy propagation (B165, B138)", () => {
  it("REG-B165 REG-B138 the staff strategy passes impersonatedBy through to req.user", async () => {
    const out = await new JwtStrategy(configService).validate({
      ...staffPayload,
      impersonatedBy: "sa1",
    });
    expect(out).toMatchObject({ sub: "ta1", id: "ta1", role: "TENANT_ADMIN", tenantId: "t1" });
    expect(out.impersonatedBy).toBe("sa1");
  });

  it("pin (B165): without the claim the staff result carries impersonatedBy undefined and no isAdmin", async () => {
    const out = await new JwtStrategy(configService).validate(staffPayload);
    expect(out.impersonatedBy).toBeUndefined();
    expect(out).not.toHaveProperty("isAdmin");
  });

  it("REG-B165 the buyer strategy passes impersonatedBy through", async () => {
    const out = await new BuyerJwtStrategy(configService).validate({
      sub: "b1",
      email: "b@x.test",
      type: "BUYER",
      impersonatedBy: "sa1",
    } as any);
    expect(out).toMatchObject({ sub: "b1", email: "b@x.test", type: "BUYER" });
    expect((out as any).impersonatedBy).toBe("sa1");
  });

  it("pin (B165): a buyer token without the claim yields impersonatedBy undefined", async () => {
    const out = await new BuyerJwtStrategy(configService).validate({
      sub: "b1",
      email: "b@x.test",
      type: "BUYER",
    } as any);
    expect((out as any).impersonatedBy).toBeUndefined();
  });
});
```

**T15** — append to `audit.interceptor.security.spec.ts` (reuse `makeCtx`/`nextHandler`; they
are declared inside the existing `describe` — either hoist them to module scope or add the new
`describe` INSIDE the existing one):

```ts
it("REG-B165 forwards req.user.impersonatedBy into the audit row (who really wrote)", async () => {
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };
  const interceptor = new AuditInterceptor(auditService as any);
  const req = {
    method: "POST",
    url: "/api/v1/orders",
    ip: "203.0.113.9",
    headers: {},
    socket: {},
    user: { sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" },
  };
  interceptor.intercept(makeCtx(req), nextHandler());
  await new Promise((r) => setImmediate(r));
  expect(auditService.log).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "ta1", tenantId: "t1", impersonatedBy: "sa1" }),
  );
});

it("REG-B165 a plain (non-impersonated) user is stamped impersonatedBy: null", async () => {
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };
  const interceptor = new AuditInterceptor(auditService as any);
  const req = {
    method: "PATCH",
    url: "/api/v1/orders/o1",
    ip: "203.0.113.9",
    headers: {},
    socket: {},
    user: { sub: "u1", tenantId: "t1" },
  };
  interceptor.intercept(makeCtx(req), nextHandler());
  await new Promise((r) => setImmediate(r));
  expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ impersonatedBy: null }));
});
```

**T16** — NEW `audit.service.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import { AuditService } from "./audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("AuditService.log (B165)", () => {
  let service: AuditService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(AuditService);
  });

  it("REG-B165 writes impersonatedBy into the AuditLog row", async () => {
    await service.log({
      tenantId: "t1",
      userId: "ta1",
      action: "POST /orders",
      entityType: "orders",
      impersonatedBy: "sa1",
    } as any);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ impersonatedBy: "sa1" }) }),
    );
  });

  it("REG-B165 writes impersonatedBy: null when the request was not impersonated", async () => {
    await service.log({
      tenantId: "t1",
      userId: "u1",
      action: "POST /orders",
      entityType: "orders",
    });
    const data = prisma.auditLog.create.mock.calls[0]![0].data;
    expect(data).toHaveProperty("impersonatedBy", null);
  });

  it("pin (B165): a failing create never rejects (audit must not fail the request)", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("column missing"));
    await expect(
      service.log({ tenantId: "t1", userId: "u1", action: "POST /x", entityType: "x" }),
    ).resolves.toBeUndefined();
  });
});
```

**T17** — NEW `impersonation.guard.spec.ts`:

```ts
import { ExecutionContext, Logger } from "@nestjs/common";
import { ImpersonationGuard } from "./impersonation.guard";

const tokenWith = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

function ctx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe("ImpersonationGuard (B165) — logs impersonated writes from the bearer claim", () => {
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });
  afterEach(() => logSpy.mockRestore());

  it("REG-B165 a POST with impersonatedBy in the bearer token logs admin/acting-as/tenant while req.user is undefined (APP_GUARD ordering)", () => {
    const token = tokenWith({ sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" });
    const req = {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
      url: "/api/v1/orders?x=1",
    };

    expect(new ImpersonationGuard().canActivate(ctx(req))).toBe(true);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = String(logSpy.mock.calls[0]![0]);
    expect(line).toContain("POST /api/v1/orders");
    expect(line).not.toContain("?x=1");
    expect(line).toContain("admin=sa1");
    expect(line).toContain("acting-as=ta1");
    expect(line).toContain("tenant=t1");
  });

  it("pin (B165): GET with the claim → true, no log", () => {
    const token = tokenWith({ sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" });
    expect(
      new ImpersonationGuard().canActivate(
        ctx({
          headers: { authorization: `Bearer ${token}` },
          method: "GET",
          url: "/api/v1/orders",
        }),
      ),
    ).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("pin (B165): no header / malformed token / no claim → true, no log, no throw", () => {
    const g = new ImpersonationGuard();
    expect(g.canActivate(ctx({ headers: {}, method: "POST", url: "/api/v1/orders" }))).toBe(true);
    expect(
      g.canActivate(
        ctx({ headers: { authorization: "Bearer not.a.jwt" }, method: "POST", url: "/x" }),
      ),
    ).toBe(true);
    expect(
      g.canActivate(
        ctx({
          headers: { authorization: `Bearer ${tokenWith({ sub: "u1", tenantId: "t1" })}` },
          method: "DELETE",
          url: "/api/v1/orders/o1",
        }),
      ),
    ).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("pin (B165): a populated req.user with the claim still logs when no header is present", () => {
    const req = {
      headers: {},
      method: "PATCH",
      url: "/api/v1/orders/o1",
      user: { sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" },
    };
    expect(new ImpersonationGuard().canActivate(ctx(req))).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0]![0])).toContain("admin=sa1");
  });
});
```

**T18** — append to `auth.controller.cookie.spec.ts` (reuse `makeController`, `makeRes`):

```ts
describe("AuthController.logout under impersonation (B138)", () => {
  it("REG-B138 an impersonated caller's logout clears the cookie and revokes NOTHING", async () => {
    const authService = {
      logout: jest.fn().mockResolvedValue({ message: "Logged out successfully" }),
    };
    const controller = makeController(authService);
    const res = makeRes();

    const result = await controller.logout({ id: "ta1", impersonatedBy: "sa1" } as any, res);

    expect(res.clearCookie).toHaveBeenCalledWith(
      "rf_refresh",
      expect.objectContaining({ path: "/api/v1/auth" }),
    );
    expect(authService.logout).not.toHaveBeenCalled();
    expect(result).toEqual({ message: "Impersonation session ended" });
  });

  it("pin (B138): an ordinary logout still revokes the caller's refresh tokens", async () => {
    const authService = {
      logout: jest.fn().mockResolvedValue({ message: "Logged out successfully" }),
    };
    const controller = makeController(authService);
    const res = makeRes();

    await controller.logout({ id: "u1" } as any, res);

    expect(authService.logout).toHaveBeenCalledTimes(1);
    expect(authService.logout).toHaveBeenCalledWith("u1");
    expect(res.clearCookie).toHaveBeenCalledWith("rf_refresh", expect.anything());
  });
});
```

(Verify the exact `clearCookie` options the controller passes — read `clearRefreshCookie` in
`auth.controller.ts` — and match them; `expect.objectContaining({ path: "/api/v1/auth" })` is the
minimum.)

### TP4 — session identity (B155-API) · T19 · R13

**File** `W/apps/api/src/auth/auth.service.spec.ts` (extend; the module builds `AuthService` with
`createMockPrisma`, `jwtService.sign → "mock-token"`, `jwtService.decode → { exp: now+3600 }`,
`entitlements.claimsFor → null`; `MOCK_USER` at :26).

Append a new `describe("refresh — in-place rotation (B155)")`:

```ts
describe("refresh — in-place rotation (B155)", () => {
  const T0 = new Date("2026-01-01T00:00:00.000Z");
  const stored = {
    id: "rt-1",
    userId: "user-1",
    tokenHash: "h-old",
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: T0,
    lastUsedAt: T0,
    userAgent: null,
    ipAddress: null,
    deviceName: null,
  };
  const newHash = () => require("crypto").createHash("sha256").update("mock-token").digest("hex");

  function prime() {
    jwtService.verify.mockReturnValue({ sub: "user-1", type: "staff" });
    prisma.refreshToken.findUnique.mockResolvedValue(stored as any);
    prisma.user.findUnique.mockResolvedValue({ ...MOCK_USER, tenantId: "tenant-1" } as any);
    prisma.tenant.findUnique.mockResolvedValue({ slug: "test-tenant" } as any);
  }

  it("REG-B155 rotates the stored row IN PLACE (same id, compare-and-swap on the old hash) and never deletes or upserts", async () => {
    prime();
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.refresh("incoming-token");

    expect(result).toHaveProperty("accessToken");
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma.refreshToken.updateMany.mock.calls[0]![0] as any;
    expect(call.where).toEqual({ id: "rt-1", tokenHash: "h-old" });
    expect(call.data.tokenHash).toBe(newHash());
    expect(call.data.expiresAt).toBeInstanceOf(Date);
    expect(call.data.lastUsedAt).toBeInstanceOf(Date);
    expect(Object.keys(call.data)).toEqual(
      expect.not.arrayContaining(["id", "createdAt", "userId", "tenantId"]),
    );
    // No deviceInfo supplied → device columns untouched (undefined, never null).
    expect(call.data.userAgent).toBeUndefined();
    expect(call.data.ipAddress).toBeUndefined();
    expect(call.data.deviceName).toBeUndefined();
    expect(prisma.refreshToken.deleteMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.upsert).not.toHaveBeenCalled();
  });

  it("pin (B155): losing the concurrent-rotation race (count 0) falls back to creating a fresh row — both refreshes succeed", async () => {
    prime();
    prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
    prisma.refreshToken.upsert.mockResolvedValue({} as any);

    const result = await service.refresh("incoming-token");

    expect(result).toHaveProperty("refreshToken");
    expect(prisma.refreshToken.upsert).toHaveBeenCalledTimes(1);
    expect((prisma.refreshToken.upsert.mock.calls[0]![0] as any).where).toEqual({
      tokenHash: newHash(),
    });
  });

  it("pin (B155): an inactive user's presented token is still consumed before the 401", async () => {
    prime();
    prisma.user.findUnique.mockResolvedValue({ ...MOCK_USER, status: "SUSPENDED" } as any);

    await expect(service.refresh("incoming-token")).rejects.toThrow(UnauthorizedException);
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: expect.any(String) },
    });
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});
```

**Vacuity guard (from the test plan):** `prisma-mock` defaults `updateMany → { count: 0 }`, so the
happy-path test MUST set `count: 1` explicitly and assert `upsert` NOT called — otherwise it
silently exercises the fallback.

Existing `refresh` tests in this file prime `refreshToken.findUnique` WITHOUT an `id` and mock
`upsert`; after WP4 they take the `count: 0` fallback path (default mock) and stay green. Do not
edit them.

---

## 2. Implementation packages (disjoint by file ownership)

### WP1 — B52: supplier-statements owner gate + JWT-path default-deny · satisfies R1 R2 · provenBy T1 T2 T3 T4 T5 T6

**File** `W/apps/api/src/uploads/uploads.controller.ts`

1. Add the eighth owner lookup to `OWNER_LOOKUPS` (after the `payments` entry, before the closing
   `};`). Key writer: `supplier-statements.service.ts:500` writes
   `supplier-statements/${scanId}/${i + 1}.${ext}`; the scan row is created via
   `forTenant().create`, so `tenantId` is injected; the model's `tenantId` is `String?`.

```ts
    // B52: `supplier-statements/<scanId>/<n>.<ext>` — the scan row owns the tenant.
    // The id segment carries no extension, so the strip below is a no-op here.
    "supplier-statements": (id) =>
      this.prisma.supplierStatementScan.findUnique({ where: { id }, select: { tenantId: true } }),
```

2. Default-deny. Immediately after the owner-lookup `if (ownerLookup && …) { … }` block (currently
   ending at line 178) and still INSIDE `if (!reqAny.signedUrlAuthorized) { … }`, add:

```ts
// B52: fail CLOSED. Every prefix StorageService writes (11 at the time of
// writing) is covered by one of the two gates above; a key under any other
// prefix — or a flat key with no prefix at all — has no owner to check and
// must not stream to a bearer caller. This runs BEFORE the filesystem check
// so 403-vs-404 never discloses whether a key exists. SUPER_ADMIN and the
// signed-URL path (a per-key capability) stay exempt.
if (!tenantMatch && !ownerLookup && caller?.role !== "SUPER_ADMIN") {
  throw new ForbiddenException("Cross-tenant file access denied");
}
```

`tenantMatch` and `ownerLookup` are both already in scope at that point (declared at :155 and
:170). A flat key (`flat.txt`) yields `prefix = "flat.txt"`, `idSegmentRaw = undefined`,
`ownerLookup = undefined` → denied. `fs.existsSync` at :190 is reached only after this block.

3. Rewrite the two comments so they are true: line 54 "Eight of the eleven storage prefixes…"
   → "Eight of the eleven storage prefixes (products, customers, expenses, invoice-scans,
   invoice-pdfs, statement-pdfs, payments, supplier-statements) embed only the OWNING ROW's id…";
   lines 162–165 → list the eight prefixes and add "Anything else is denied below (B52)."

Blast radius (record in the PR): web JWT-path fetches (`lib/fetch-pdf-blob.ts`) only hit
`invoice-pdfs/` and `statement-pdfs/`; `<img>`/portal loads use signed URLs; an EXPIRED
signature falls through to the JWT path (`uploads-access.guard.ts:46-49`) and an unknown prefix
there now 403s instead of 200 — intended.

### WP2 — B165: propagate `impersonatedBy`, stamp the audit row, make the guard observe the claim · satisfies R8 R9 R10 · provenBy T14 T15 T16 T17

**Files**

- `W/apps/api/src/auth/strategies/jwt.strategy.ts`
- `W/apps/api/src/buyer/strategies/buyer-jwt.strategy.ts`
- `W/apps/api/src/auth/guards/impersonation.guard.ts`
- `W/apps/api/src/audit/audit.interceptor.ts`
- `W/apps/api/src/audit/audit.service.ts`

**jwt.strategy.ts** — in `validate()`'s returned literal, after `tenantSlug: payload.tenantSlug ?? null,`
and before the `canActActAsDriver` comment block, add exactly:

```ts
      // B165 / B138: present only on platform-admin impersonation tokens
      // (platform-admin.service.ts mints it). NOT an authorization input —
      // RolesGuard ignores it; AuditInterceptor stamps it and AuthController.logout
      // reads it. Absent stays absent (never a fabricated value).
      impersonatedBy: payload.impersonatedBy ?? undefined,
```

`isAdmin` stays un-propagated (the #491 reasoning in the file holds).

**buyer-jwt.strategy.ts** — replace the return line with:

```ts
return {
  sub: payload.sub,
  email: payload.email,
  type: "BUYER" as const,
  // B165: buyer-admin.service.ts mints this on buyer impersonation tokens; propagate
  // for logging/UI only (no buyer logout change in this batch — spec §4.4).
  impersonatedBy: payload.impersonatedBy ?? undefined,
};
```

**audit.service.ts** — add to `CreateAuditLogDto`:

```ts
  /** Platform-admin id when the write happened under impersonation (AuditLog.impersonatedBy, F01). */
  impersonatedBy?: string | null;
```

and to the `create({ data: { … } })` literal, after `ip: dto.ip ?? null,`:

```ts
          impersonatedBy: dto.impersonatedBy ?? null,
```

The surrounding `try/catch` is unchanged (an audit write must never fail the request).

**audit.interceptor.ts** — in the `this.auditService.log({ … })` literal, after `userId: user?.sub ?? null,`:

```ts
            // B165: the interceptor runs AFTER route guards, so this is the VERIFIED
            // req.user (JwtStrategy output) — the durable trail names who really wrote.
            impersonatedBy: user?.impersonatedBy ?? null,
```

**impersonation.guard.ts** — replace the whole file body (keep the docblock, extend it):

```ts
import { Injectable, CanActivate, ExecutionContext, Logger } from "@nestjs/common";

interface ImpersonationClaims {
  impersonatedBy?: string;
  sub?: string;
  tenantId?: string | null;
}

/**
 * Impersonation audit-trail guard.
 *
 * Impersonation sessions have FULL write access — the super-admin acts with
 * the same permissions as the impersonated tenant-admin user. This guard
 * does NOT block any operations; it exists solely to log write actions for
 * the audit trail so support workflows are traceable.
 *
 * B165: it is registered as an APP_GUARD (app.module.ts) and Nest runs global
 * guards BEFORE route-level guards, while JwtAuthGuard is route-level only — so
 * `request.user` is never populated here and the original `request.user`-based
 * check never fired once. We therefore decode the bearer payload segment WITHOUT
 * verifying the signature (the same approach TenantStatusGuard uses); that is
 * acceptable for a log-only side effect because JwtAuthGuard still verifies the
 * token downstream. `request.user` is preferred when a future ordering sets it.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  private readonly logger = new Logger(ImpersonationGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const claims = this.readClaims(request);

    // If not impersonating, nothing to log
    if (!claims?.impersonatedBy) return true;

    const method = String(request.method ?? "GET").toUpperCase();
    const path = String(request.url ?? "").split("?")[0];

    // Log write operations made during impersonation for audit trail
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      this.logger.log(
        `Impersonation write: ${method} ${path} ` +
          `(admin=${claims.impersonatedBy}, acting-as=${claims.sub}, tenant=${claims.tenantId})`,
      );
    }

    // Always allow — impersonation sessions have full write access
    return true;
  }

  private readClaims(request: any): ImpersonationClaims | null {
    if (request?.user?.impersonatedBy) return request.user as ImpersonationClaims;
    const authHeader: unknown = request?.headers?.authorization;
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) return null;
    try {
      const payloadPart = authHeader.slice(7).split(".")[1];
      if (!payloadPart) return null;
      const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      return typeof payload?.impersonatedBy === "string" ? (payload as ImpersonationClaims) : null;
    } catch {
      // Malformed JWT — nothing to log; JwtAuthGuard rejects it downstream.
      return null;
    }
  }
}
```

No edit to `tenant/tenant-status.guard.ts` (its "same approach used by ImpersonationGuard"
comment becomes true). No edit to `app.module.ts`.

### WP3 — B138 (API half): logout under impersonation revokes nothing · satisfies R11 · provenBy T18 (+ T21(e) post-deploy)

**File** `W/apps/api/src/auth/auth.controller.ts` — replace the `logout` handler (lines ~102–111):

```ts
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Logout and revoke all refresh tokens" })
  async logout(
    @CurrentUser() user: { id: string; impersonatedBy?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    // SEC-4 / F11-002: drop the httpOnly refresh cookie alongside server-side revocation.
    this.clearRefreshCookie(res);
    // B138: an impersonation token's `sub` IS the tenant's TENANT_ADMIN
    // (platform-admin.service.ts impersonate()), so revoking "the caller's" refresh
    // tokens would sign that admin out of every device. An impersonation has no
    // refresh token of its own — there is nothing to revoke. The claim reaches
    // req.user through JwtStrategy (B165); RolesGuard never reads it.
    if (user.impersonatedBy) {
      return { message: "Impersonation session ended" };
    }
    return this.authService.logout(user.id);
  }
```

Depends logically on WP2 (the claim must reach `req.user`) but shares no file — no `dependsOn`.

### WP4 — B155 (API half): refresh rotates the session row in place · satisfies R13 · provenBy T19 (+ T22 post-deploy)

**File** `W/apps/api/src/auth/auth.service.ts` — inside `refresh()` only. Every other
`RefreshToken` writer (`login`/`mintSessionForUser` → `storeRefreshToken`, `logout`,
`revokeSession`, `:472`, `:564`, `google-oauth.service.ts:739`) is UNTOUCHED — a login IS a new
session.

Columns the rotation writes (L-037 enumeration): `tokenHash` (the invalidation of the old
token), `expiresAt` (new token's exp), `lastUsedAt` (now), `userAgent`/`ipAddress`/`deviceName`
ONLY when `deviceInfo` was supplied (else `undefined` → Prisma leaves them). NEVER written:
`id`, `createdAt`, `userId`, `tenantId` — `id` is what the Active Sessions UI keys on and
`createdAt` is the real sign-in time.

Edit steps:

1. DELETE these two lines (currently :244–:245):

```ts
// Rotate — delete old, issue new pair (deleteMany avoids P2025 on race)
await this.prisma.refreshToken.deleteMany({ where: { tokenHash } });
```

2. Replace the inactive-user check (currently :247–:250) with — the presented token must still be
   consumed before the 401, exactly as the old ordering did:

```ts
const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
if (!user || user.status !== "ACTIVE" || user.deletedAt) {
  // B155: the old delete-then-check ordering consumed the token here too —
  // keep that, or a suspended user's row survives in listSessions.
  await this.prisma.refreshToken.deleteMany({ where: { tokenHash } });
  throw new UnauthorizedException("Account unavailable");
}
```

3. Replace the tail — from `// Preserve device info from old token if not provided` through
   `await this.storeRefreshToken(user.id, refreshToken, effectiveDeviceInfo);` — with:

```ts
// B155: rotate IN PLACE. The old code deleted the row and upserted a NEW one
// (a new id + createdAt every ~15 min), so Active Sessions showed the last
// rotation as "Signed in" and Revoke-by-listed-id 403'd after any rotation.
// Compare-and-swap on { id, oldHash }: the update IS the invalidation of the
// old token. `id`/`createdAt`/`userId` are never written.
const now = new Date();
const newTokenHash = this.hashToken(refreshToken);
const newExpiresAt = new Date(this.jwtService.decode(refreshToken).exp * 1000);
const { count } = await this.prisma.refreshToken.updateMany({
  where: { id: stored.id, tokenHash },
  data: {
    tokenHash: newTokenHash,
    expiresAt: newExpiresAt,
    lastUsedAt: now,
    // Only overwrite device columns when the caller supplied them (mirrors the
    // old upsert's `update` branch); `undefined` leaves a column untouched.
    userAgent: deviceInfo?.userAgent,
    ipAddress: deviceInfo?.ipAddress,
    deviceName: deviceInfo?.deviceName,
  },
});

if (count === 0) {
  // Lost a concurrent-rotation race: another refresh of the same token already
  // swapped the hash. Preserve the old tolerance (the deleteMany comment's
  // "avoids P2025 on race") — give the loser a fresh row so BOTH refreshes
  // succeed exactly as before.
  const effectiveDeviceInfo: DeviceInfo = deviceInfo ?? {
    userAgent: stored.userAgent ?? undefined,
    ipAddress: stored.ipAddress ?? undefined,
    deviceName: stored.deviceName ?? undefined,
  };
  await this.storeRefreshToken(user.id, refreshToken, effectiveDeviceInfo);
}
```

`storeRefreshToken` and `hashToken` stay as they are (private helpers, still used by login).
Mobile posts the body token to the same endpoint and is unaffected. `listSessions`'
`orderBy createdAt desc` now orders by real sign-in time.

### WP5 — B168: inventory writes inherit the class-level OPERATOR gate · satisfies R7 · provenBy T12 T13

**File** `W/apps/api/src/inventory/inventory.controller.ts` — DELETE the handler-level line
`@Roles(UserRole.OPERATOR, UserRole.DRIVER)` on exactly these four handlers: `recordPurchase`
(`@Post("movements/purchase")`), `recordAdjustment` (`@Post("movements/adjustment")`), `createPO`
(`@Post("purchase-orders")`), `receivePO` (`@Post("purchase-orders/:id/receive")`). They then
inherit the class-level `@Roles(UserRole.OPERATOR)` exactly like `sendPO`/`closePO`. Do NOT touch
the four reads (`getStockOverview`, `listMovements`, `listPOs`, `getPO`) — T13 pins them. Add a
one-line comment above `recordPurchase`: `// B168: writes inherit the class-level OPERATOR gate; DRIVER reads below are deliberate.`

### WP6 — B132: `POST /customers/:id/prices` is OPERATOR-only, refused before any read · satisfies R3 R4 · provenBy T7 T8

**Files**

- `W/apps/api/src/customers/customers.controller.ts` — on `upsertCustomerPrice` change
  `@Roles(UserRole.OPERATOR, UserRole.DRIVER)` → `@Roles(UserRole.OPERATOR)` (matches its
  `deleteCustomerPrice` sibling). `GET :id/prices` keeps DRIVER (read — out of scope).
- `W/apps/api/src/customers/customers.service.ts` — `upsertCustomerPrice`:
  1. Signature: `user?: JwtPayload` → `user: JwtPayload` (single caller passes it).
  2. Hoist the role gate to the very top, BEFORE the empty-DTO check, `assertMsrpAllowed()` and
     `customerPrice.findUnique`:

```ts
  async upsertCustomerPrice(customerId: string, dto: UpsertCustomerPriceDto, user: JwtPayload) {
    // B132: authorization before semantics and before ANY read — a non-operator must
    // not learn whether an override exists. The role set is the DELETE sibling's
    // effective set under RolesGuard's ROLE_SATISFIES (TENANT_ADMIN ⊇ OPERATOR).
    const role = user?.role as UserRole | undefined;
    const operatorLevel =
      role === UserRole.OPERATOR || role === UserRole.TENANT_ADMIN || role === UserRole.SUPER_ADMIN;
    if (!operatorLevel) {
      throw new ForbiddenException("Only operators can change a price override");
    }
    if (dto.pricingTier === undefined && dto.msrp === undefined) {
      throw new BadRequestException("Provide a pricing tier, an MSRP override, or both");
    }
```

3. In the clear-both branch, DELETE the now-redundant inner block (the comment "Clearing both
   fields removes the row…" through `throw new ForbiddenException("Only operators can remove a
price override");` and its closing brace), leaving just
   `await this.prisma.forTenant().customerPrice.delete({ where: { id: existing.id } });`.
   Replace that comment with `// Clearing both fields removes the row (role already gated above — B132).`

### WP7 — B133: standing-order mutations exclude DRIVER; `addItem` goes through the ownership wrapper · satisfies R5 R6 · provenBy T9 T10 T11

**Files**

- `W/apps/api/src/order-templates/order-templates.controller.ts`
- `W/apps/api/src/order-templates/order-templates.service.ts`

**Land this package LAST in the batch** (F13 edits `createOrderFromTemplate` :309–372 and may
extend `updateForUser` in the same service file — different regions; whichever lands second
rebases).

Controller:

- `create`: `@Roles(UserRole.OPERATOR, UserRole.CUSTOMER, UserRole.DRIVER)` → `@Roles(UserRole.OPERATOR, UserRole.CUSTOMER)`
- `update`: same change.
- `removeItem`: same change.
- `addItem`: replace the whole handler with

```ts
  @Post(":id/items")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  addItem(
    @Param("id") templateId: string,
    @Body() dto: AddTemplateItemDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.addItemForUser(templateId, dto, user);
  }
```

Service — beside `removeItemForUser` / `generateOrderForUser` (the "SECURITY (F2-003)" block,
~:240–249), add:

```ts
  // B133: every mutation on the controller goes through an ownership wrapper. For
  // OPERATOR this is a pass-through today (the ownership branch is CUSTOMER-only);
  // its value is uniformity — a future CUSTOMER grant on addItem cannot ship unguarded.
  async addItemForUser(templateId: string, dto: AddTemplateItemDto, user: JwtPayload) {
    await this.findOneForUser(templateId, user);
    return this.addItem(templateId, dto);
  }
```

Reads `findAll`/`findOne` stay without `@Roles` (residual recorded in spec §4.1).

### WP8 — B138 (web half): the header offers "Exit impersonation", never "Sign out", while impersonation state exists · satisfies R12 · provenBy T21 (post-deploy)

**Files**

- `W/apps/web/lib/impersonation.ts`
- `W/apps/web/app/(dashboard)/layout.tsx`
- `W/apps/web/lib/i18n/messages.ts`

**lib/impersonation.ts** — add at top `import { clearTenantCookie } from "./tenant-cookie";`
(`tenant-cookie.ts` imports nothing from this module — no cycle) and export ONE exit function
(L-030: one decision, one place):

```ts
/**
 * End an impersonation from the UI. Used by BOTH the red banner and the avatar
 * menu's "Exit impersonation" item (B138) — one copy, never two.
 *
 * Never POSTs /auth/logout: an impersonation token's `sub` is the tenant's
 * TENANT_ADMIN, so a server logout would revoke that admin's sessions on every
 * device. The super-admin's own session carries no tenant, so there is nothing
 * to re-pin the cookie from. Hard-load (not router.push) so every provider —
 * AuthProvider, TenantProvider, the nav — remounts cleanly on the operator
 * session instead of carrying impersonated state over a soft nav.
 */
export function exitImpersonation(): void {
  if (typeof window === "undefined") return;
  clearTenantCookie();
  clearImpersonation();
  window.location.href = "/admin/tenants";
}
```

**lib/i18n/messages.ts** — in `en` after `"menu.signOut": "Sign out",`:

```ts
  "menu.exitImpersonation": "Exit impersonation",
  "menu.returnToAdmin": "Return to admin",
```

and in `es` after `"menu.signOut": "Cerrar sesión",`:

```ts
  "menu.exitImpersonation": "Salir de la suplantación",
  "menu.returnToAdmin": "Volver al panel de administración",
```

(`es` is typed `Messages = Record<MessageKey, string>`, so omitting either key is a type error.)

**layout.tsx**

1. Imports: extend the `@/lib/impersonation` import with `exitImpersonation`. Remove
   `import { clearTenantCookie } from "@/lib/tenant-cookie";` and `clearImpersonation` from the
   import list ONLY if the banner edit below leaves them unused (grep the file — at `39632d27`
   their only uses are the banner's `exit()` body at :980–981).
2. In `Header` (after `const { enabled: routesAccess } = useRoutesAccess();`), subscribe exactly
   as the banner does:

```tsx
// B138: mirror ImpersonationBanner's read so the avatar menu never offers
// "Sign out" while impersonation state exists (expired included — an expired
// impersonation plus a /auth/logout POST races api-client's auto-exit).
const [imp, setImp] = React.useState<ImpersonationState | null>(null);
React.useEffect(() => {
  const read = () => setImp(getImpersonation());
  read();
  return subscribeImpersonation(read);
}, []);
React.useEffect(() => {
  setImp(getImpersonation());
}, [pathname]);
```

3. Replace the sign-out `DropdownMenu.Item` (currently :947–:951) with:

```tsx
{
  imp ? (
    <DropdownMenu.Item
      className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-danger outline-none hover:bg-danger-bg"
      onSelect={() => exitImpersonation()}
    >
      <LogOut className="h-4 w-4" />
      {t(imp.expired ? "menu.returnToAdmin" : "menu.exitImpersonation")}
    </DropdownMenu.Item>
  ) : (
    <DropdownMenu.Item
      className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-danger outline-none hover:bg-danger-bg"
      onSelect={() => void logout()}
    >
      <LogOut className="h-4 w-4" />
      {t("menu.signOut")}
    </DropdownMenu.Item>
  );
}
```

4. In `ImpersonationBanner`, delete the local `const exit = () => { … };` (and its comment — it
   now lives in `lib/impersonation.ts`) and change `onClick={exit}` → `onClick={exitImpersonation}`.
   Keep the labels ("Return to admin" / "Exit impersonation") as they are.

`api-client.ts` and `lib/auth.ts` are NOT edited (spec §4.5, R12).

### WP9 — B155 (web half): Active Sessions tells the truth · satisfies R14 · provenBy T22 T23 (post-deploy)

**File** `W/apps/web/app/(dashboard)/settings/page.tsx` — `SessionsCard` (~:1614–1665) only.

1. The row: `<li key={session.id} className=…>` → `<li key={session.id} data-session-id={session.id} className=…>`.
2. `handleRevoke` catch → reload so a stale row disappears:

```ts
    } catch {
      toast({ title: "Failed to revoke session", variant: "error" });
      // B155: the row we showed may already be gone server-side — re-sync instead
      // of leaving a phantom the user cannot act on.
      await loadSessions();
    } finally {
```

3. `handleRevokeAll` — honest:

```ts
const handleRevokeAll = async () => {
  setRevokingAll(true);
  setConfirmRevokeAll(false);
  const results = await Promise.allSettled(
    sessions.map((s) => apiClient.delete(`/auth/sessions/${s.id}`)),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed === 0) {
    setSessions([]);
    toast({ title: "All sessions revoked", variant: "success" });
  } else {
    // B155: never claim success for a call that failed.
    toast({ title: "Some sessions could not be revoked", variant: "error" });
    await loadSessions();
  }
  setRevokingAll(false);
};
```

No layout change.

### WP10 — e2e specs 31 and 32, project entries, tenant-admin seed · satisfies R15 R16 · authors T21 T22 T23 (proven post-deploy)

**Files**

- `W/apps/web/e2e/31-impersonation-signout.spec.ts` (NEW)
- `W/apps/web/e2e/32-active-sessions.spec.ts` (NEW)
- `W/apps/web/e2e/helpers/constants.ts`
- `W/apps/web/playwright.config.ts`
- `W/apps/api/scripts/e2e-seed.js`

**Never execute these specs locally.** Typecheck with `npm --prefix W/apps/web run check-types`.

**constants.ts** — add to `CREDENTIALS`:

```ts
  tenantAdmin: { username: "e2e_admin", password: "TenantAdmin1!" },
```

**e2e-seed.js** — beside the operator/customer constants:

```js
const TENANT_ADMIN_USERNAME = "e2e_admin";
const TENANT_ADMIN_PASSWORD = "TenantAdmin1!";
```

Existing-tenant branch — after the customer `if (!cu) {…}` block:

```js
// ── TENANT_ADMIN (B138 e2e precondition) ────────────────────────────────────
// platform-admin impersonate() requires an ACTIVE TENANT_ADMIN; without one the
// e2e tenant cannot be impersonated and spec 31 skips.
const ta = await prisma.user.findFirst({
  where: { tenantId: existing.id, username: TENANT_ADMIN_USERNAME },
});
if (!ta) {
  const hash = await bcrypt.hash(TENANT_ADMIN_PASSWORD, 10);
  await prisma.user.create({
    data: {
      email: "e2e_admin@e2e-routeflow.test",
      username: TENANT_ADMIN_USERNAME,
      password: hash,
      role: "TENANT_ADMIN",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: existing.id,
    },
  });
  console.log(`  ✓ Created missing tenant admin: ${TENANT_ADMIN_USERNAME}`);
} else {
  console.log(`  ✓ Tenant admin "${TENANT_ADMIN_USERNAME}" exists`);
}
```

Fresh-tenant branch — after the customer `prisma.user.create` block:

```js
// ── Tenant admin user (B138 e2e precondition) ────────────────────────────────
await prisma.user.create({
  data: {
    email: "e2e_admin@e2e-routeflow.test",
    username: TENANT_ADMIN_USERNAME,
    password: await bcrypt.hash(TENANT_ADMIN_PASSWORD, 10),
    role: "TENANT_ADMIN",
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId: tenant.id,
  },
});
console.log(`  ✓ Tenant admin created: ${TENANT_ADMIN_USERNAME} / ${TENANT_ADMIN_PASSWORD}`);
```

Update the header comment (`•   Tenant admin: e2e_admin / TenantAdmin1!`). The script's first
statement is already `assertTestTenant("e2e-routeflow", …)` — unchanged. **The prod reseed is an
OWNER/LEAD action** (`railway run --service postgres node apps/api/scripts/e2e-seed.js`); record
that in the PR body.

**playwright.config.ts** — append two projects before the closing `],`:

```ts
    // ── Impersonation sign-out (F14, spec 31) ──────────────────────────────────
    // REG-B138: while impersonating, the avatar menu offers "Exit impersonation"
    // and never "Sign out"; exiting POSTs no /auth/logout and the impersonated
    // TENANT_ADMIN's session count is unchanged (server-side, read through a token
    // the UI never touches). No storageState — the spec manages the super-admin
    // and tenant-admin sessions itself. Skips (NOT a discharge — L-041) until
    // PLAYWRIGHT_SA_* are set and e2e-seed.js has seeded `e2e_admin` on the target.
    // Targets e2e-routeflow BY SLUG, never `tenants?limit=1`.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "impersonation-signout",
      testMatch: /31-impersonation-signout\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Active Sessions identity (F14, spec 32) ────────────────────────────────
    // REG-B155: a session row captured BEFORE a refresh-token rotation is still
    // listed (same id, same createdAt) and can be revoked; the revoke bites (the
    // rotated token then 401s); a failed revoke re-syncs the list. NO storageState
    // on purpose — the spec revokes its OWN fresh login and must never consume the
    // shared operator.json refresh token.
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's precedent.
    {
      name: "active-sessions",
      testMatch: /32-active-sessions\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
```

**31-impersonation-signout.spec.ts** — skeleton (fill in with the same helpers CC-05 uses:
`loginAsSuperAdmin`, `logout` from `./helpers/auth`; `apiBase` from `./helpers/api`;
`CREDENTIALS`, `TENANT_SLUG`, `HAS_SUPER_ADMIN_CREDS` from `./helpers/constants`). Key facts:
`POST /api/v1/auth/login` body `{ username, password }` + header `X-Tenant-Slug`; response has
`accessToken`; `GET /api/v1/auth/sessions` (bearer) returns an array of `{ id, createdAt, … }`;
`GET /api/v1/platform-admin/tenants?search=e2e-routeflow` (bearer `localStorage.superAdminToken`)
returns `{ data: [{ id, slug, … }] }`; `POST /api/v1/platform-admin/tenants/<id>/impersonate`
returns `{ accessToken, impersonatedUser: { username } }`; the admin list page
(`/admin/tenants`) has a search input with placeholder `Search by slug or name...` and a row
button `Impersonate` whose handler stores the three localStorage keys, sets the tenant cookie and
hard-loads `/dashboard`; the header trigger is `getByRole("button", { name: "Open user menu" })`;
Radix items are `role="menuitem"`; the banner text contains `Impersonating` + the slug.

```ts
import { test, expect } from "@playwright/test";
import { loginAsSuperAdmin, logout } from "./helpers/auth";
import { apiBase } from "./helpers/api";
import { CREDENTIALS, HAS_SUPER_ADMIN_CREDS, TENANT_SLUG } from "./helpers/constants";

test.describe("Impersonation sign-out (F14 / B138)", () => {
  test("REG-B138 exiting an impersonation from the avatar menu revokes none of the tenant admin's sessions and never posts /auth/logout", async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!HAS_SUPER_ADMIN_CREDS, "PLAYWRIGHT_SA_USERNAME / PLAYWRIGHT_SA_PASSWORD not set");
    const api = `${apiBase(baseURL ?? page.url())}/api/v1`;
    const tenantHeaders = { "X-Tenant-Slug": TENANT_SLUG };

    // 1. A real TENANT_ADMIN session to protect (independent of anything the UI does).
    const adminLogin = await page.request.post(`${api}/auth/login`, {
      headers: tenantHeaders,
      data: {
        username: CREDENTIALS.tenantAdmin.username,
        password: CREDENTIALS.tenantAdmin.password,
      },
    });
    test.skip(
      adminLogin.status() !== 200,
      `e2e tenant has no TENANT_ADMIN (login ${adminLogin.status()}) — run apps/api/scripts/e2e-seed.js`,
    );
    const adminAccess = (await adminLogin.json()).accessToken as string;
    const adminHeaders = { Authorization: `Bearer ${adminAccess}`, ...tenantHeaders };
    const sessionsBefore = (await (
      await page.request.get(`${api}/auth/sessions`, { headers: adminHeaders })
    ).json()) as { id: string }[];
    expect(sessionsBefore.length).toBeGreaterThanOrEqual(1);
    const protectedSessionId = sessionsBefore[0]!.id;

    let logoutCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("/auth/logout")) logoutCalls += 1;
    });

    try {
      // 2. Super-admin → find the e2e tenant BY SLUG (client-data policy: never `limit=1`).
      await loginAsSuperAdmin(page);
      const saToken = await page.evaluate(() => localStorage.getItem("superAdminToken") ?? "");
      const list = await (
        await page.request.get(`${api}/platform-admin/tenants?search=${TENANT_SLUG}&limit=50`, {
          headers: { Authorization: `Bearer ${saToken}` },
        })
      ).json();
      const matches = (list?.data ?? []).filter((t: { slug: string }) => t.slug === TENANT_SLUG);
      test.skip(matches.length !== 1, `e2e tenant not found by slug (${matches.length} matches)`);
      const tenant = matches[0] as { id: string; slug: string };

      // 3. Enter impersonation through the real UI (fallback: API + localStorage).
      await page.goto("/admin/tenants");
      await page.getByPlaceholder("Search by slug or name...").fill(TENANT_SLUG);
      const row = page.getByRole("row", { name: new RegExp(TENANT_SLUG) }).first();
      const impersonateBtn = row.getByRole("button", { name: "Impersonate" });
      if (await impersonateBtn.count()) {
        await impersonateBtn.click();
      } else {
        const imp = await (
          await page.request.post(`${api}/platform-admin/tenants/${tenant.id}/impersonate`, {
            headers: { Authorization: `Bearer ${saToken}` },
          })
        ).json();
        await page.evaluate(
          ([token, slug, username]) => {
            localStorage.setItem("impersonationToken", token);
            localStorage.setItem("impersonationTenantSlug", slug);
            if (username) localStorage.setItem("impersonationUsername", username);
          },
          [
            imp.accessToken as string,
            tenant.slug,
            (imp.impersonatedUser?.username ?? "") as string,
          ],
        );
        await context.setExtraHTTPHeaders({ "x-tenant-slug": TENANT_SLUG });
        await page.goto("/dashboard");
      }
      await page.waitForURL("**/dashboard", { timeout: 30_000 });
      await expect(page.getByText(/Impersonating/)).toBeVisible();
      const impToken = await page.evaluate(() => localStorage.getItem("impersonationToken") ?? "");
      expect(impToken).not.toBe("");
      const impHeaders = { Authorization: `Bearer ${impToken}`, ...tenantHeaders };
      const nBefore = (
        (await (
          await page.request.get(`${api}/auth/sessions`, { headers: impHeaders })
        ).json()) as unknown[]
      ).length;
      expect(nBefore).toBeGreaterThanOrEqual(1);

      // 4. The menu: no "Sign out"; "Exit impersonation" lands on /admin/tenants.
      await page.getByRole("button", { name: "Open user menu" }).click();
      await expect(page.getByRole("menuitem", { name: "Sign out" })).toHaveCount(0);
      const exitItem = page.getByRole("menuitem", { name: "Exit impersonation" });
      await expect(exitItem).toBeVisible();
      await exitItem.click();
      await page.waitForURL("**/admin/tenants", { timeout: 30_000 });
      expect(await page.evaluate(() => localStorage.getItem("impersonationToken"))).toBeNull();
      expect(logoutCalls).toBe(0);

      // 5. Server-side truth through a token the UI never touched: nothing was revoked.
      const after = (await (
        await page.request.get(`${api}/auth/sessions`, { headers: impHeaders })
      ).json()) as { id: string }[];
      expect(after.length).toBe(nBefore);
      expect(after.some((s) => s.id === protectedSessionId)).toBe(true);
    } finally {
      await page.request
        .delete(`${api}/auth/sessions/${protectedSessionId}`, { headers: adminHeaders })
        .catch(() => null);
      await logout(page);
    }
  });
});
```

(If the admin list is not a `<table>` — check `app/(platform-admin)/admin/tenants/page.tsx` around
:674 — replace the `getByRole("row")` locator with `page.locator("li, tr").filter({ hasText: TENANT_SLUG })`;
the API fallback branch guarantees the test still exercises the menu.)

**32-active-sessions.spec.ts** — use BODY refresh tokens, not the cookie (deterministic across
cookie policies): the web app stores the refresh token at `localStorage["rf:op:refreshToken"]`
(legacy `refreshToken`); `POST /api/v1/auth/refresh` accepts `{ refreshToken }` and returns a new
`{ accessToken, refreshToken }`.

```ts
import { test, expect } from "@playwright/test";
import { loginAsOperator, setTenantCookie } from "./helpers/auth";
import { apiBase, operatorAccessToken } from "./helpers/api";
import { TENANT_SLUG } from "./helpers/constants";

type SessionRow = { id: string; createdAt: string };

async function refreshTokenFromPage(page: import("@playwright/test").Page) {
  return page.evaluate(
    () => localStorage.getItem("rf:op:refreshToken") || localStorage.getItem("refreshToken") || "",
  );
}

test.describe("Active Sessions identity (F14 / B155)", () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await setTenantCookie(context, baseURL ?? "", TENANT_SLUG);
  });

  test("REG-B155 a session captured before a rotation is still listed with its sign-in time, can be revoked, and the revoke bites", async ({
    page,
    baseURL,
  }) => {
    await loginAsOperator(page);
    const api = `${apiBase(baseURL ?? page.url())}/api/v1`;
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "X-Tenant-Slug": TENANT_SLUG,
    });

    const token0 = await operatorAccessToken(page);
    const rows = (await (
      await page.request.get(`${api}/auth/sessions`, { headers: headers(token0) })
    ).json()) as SessionRow[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const sid = rows[0]!.id; // newest createdAt = this login (CI runs workers: 1)
    const signedInAt = rows[0]!.createdAt;

    // Rotate: the row must keep its id and createdAt.
    const rt0 = await refreshTokenFromPage(page);
    expect(rt0).not.toBe("");
    const refresh1 = await page.request.post(`${api}/auth/refresh`, {
      headers: { "X-Tenant-Slug": TENANT_SLUG },
      data: { refreshToken: rt0 },
    });
    expect(refresh1.status()).toBe(200);
    const pair1 = (await refresh1.json()) as { accessToken: string; refreshToken: string };
    const rows2 = (await (
      await page.request.get(`${api}/auth/sessions`, { headers: headers(pair1.accessToken) })
    ).json()) as SessionRow[];
    const survivor = rows2.find((r) => r.id === sid);
    expect(survivor).toBeDefined();
    expect(survivor!.createdAt).toBe(signedInAt);

    // The UI still shows that row and can revoke it.
    await page.goto("/settings?tab=account");
    const row = page.locator(`[data-session-id="${sid}"]`);
    await row.scrollIntoViewIfNeeded();
    await expect(row).toBeVisible();
    const revokeResp = page.waitForResponse(
      (r) => r.url().includes(`/auth/sessions/${sid}`) && r.request().method() === "DELETE",
    );
    await row.getByRole("button", { name: "Revoke" }).click();
    expect((await revokeResp).status()).toBe(200);
    await expect(page.getByText("Session revoked")).toBeVisible();
    await expect(row).toHaveCount(0);

    // The revoke hit THIS session: the rotated refresh token is dead.
    const refresh2 = await page.request.post(`${api}/auth/refresh`, {
      headers: { "X-Tenant-Slug": TENANT_SLUG },
      data: { refreshToken: pair1.refreshToken },
    });
    expect(refresh2.status()).toBe(401);
  });

  test("REG-B155 a failed revoke re-syncs the list instead of leaving a phantom row", async ({
    page,
    baseURL,
  }) => {
    await loginAsOperator(page);
    let routeHits = 0;
    let listCalls = 0;
    await page.route("**/auth/sessions/*", (route) => {
      if (route.request().method() === "DELETE") {
        routeHits += 1;
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: '{"message":"Session not found"}',
        });
      }
      return route.continue();
    });
    page.on("request", (r) => {
      if (r.request().method() === "GET" && /\/auth\/sessions(\?|$)/.test(r.url())) listCalls += 1;
    });

    await page.goto("/settings?tab=account");
    const firstRow = page.locator("[data-session-id]").first();
    await firstRow.scrollIntoViewIfNeeded();
    await expect(firstRow).toBeVisible();
    const listCallsBefore = listCalls;

    await firstRow.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Failed to revoke session")).toBeVisible();
    expect(routeHits).toBe(1);
    await expect.poll(() => listCalls).toBe(listCallsBefore + 1);

    // Cleanup: nothing to revoke — the DELETE was intercepted; the session dies with the context.
    void baseURL;
  });
});
```

(`page.on("request")` handlers receive a `Request`, not a `Route` — use `r.method()` and `r.url()`
directly; adjust the two listener bodies accordingly when typechecking.)

### WP11 — close-out bookkeeping · dependsOn WP1–WP10 (documents their final shape)

**Files**

- `W/.claude/code-map/api.md`, `W/.claude/code-map/web.md`, `W/.claude/code-map/CHANGELOG.md`, `W/.claude/code-map/_meta.json`
- `W/.claude/lessons/LESSONS.md`, `W/.claude/lessons/_meta.json`
- `W/.claude/campaign/status/F14.jsonl`

1. **Code map (surgical).** `api.md`: one bullet each under the existing B12 uploads note (B52:
   eighth owner lookup + JWT-path default-deny), the `jwt.strategy.ts` note (impersonatedBy
   propagated, staff + buyer), a new note for `impersonation.guard.ts` (reads the bearer claim;
   APP_GUARD ordering), `audit.interceptor.ts`/`audit.service.ts` (impersonatedBy stamped),
   `auth.controller.ts logout` (no revoke under impersonation), `auth.service.ts refresh()`
   (in-place rotation, count-0 fallback, inactive consumption), the three DRIVER-grant removals
   (customers prices POST, order-templates create/update/addItem/removeItem + `addItemForUser`,
   inventory four writes). `web.md`: `lib/impersonation.ts exitImpersonation()` is the single
   exit; Header sign-out slot rule; `settings/page.tsx SessionsCard` data-session-id + honest
   revoke-all; e2e 31/32 + their project entries; `e2e-seed.js` tenant admin. `CHANGELOG.md`:
   one dated bullet at the top; `_meta.json`: set `mappedSha` to the branch HEAD, `generatedAt`,
   and REPLACE `notes` with the new bullet (never accumulate).
2. **Lesson L-044** (id pre-allocated by SEQUENCE §4; `_meta.json.nextId` is 42 — do NOT take 42;
   L-042/L-043 are reserved for other batches, gaps are reserved, ids are immutable). Run
   `node scripts/validate-lessons.mjs` first and read its `binding:` line (currently
   `size (~13 more entries)`). Append under `## security` (category `security`) in the register's
   entry format (`### L-044 · 2026-09-02 · security` + Symptom / Root cause / **Lesson** / Guard),
   no client identifiers, ≤ ~1 KB. Draft:
   - **Symptom:** four fixes in one batch were "protected" by things that had never once done
     anything — a log-only APP_GUARD that read `req.user` before any route guard populated it
     (never fired), and a green unit test asserting a DRIVER _may_ write a price override (it
     asserted the bug).
   - **Root cause:** a guard that always returns `true` and a test that always passes are
     indistinguishable from working ones; nobody had asked what would turn either red.
   - **Lesson:** **Green is a claim, not evidence. Before inverting a requirement, grep the
     suites for a test that asserts the OLD behaviour (it passes on the bug — invert it, don't
     route around it); before trusting a side-effect-only guard or interceptor, name the input
     that makes it act and prove that input exists at that point in the pipeline (APP_GUARDs run
     before route guards, so `req.user` is never set there).**
   - **Guard:** `REG-B132` (the inverted test) and `REG-B165` (`impersonation.guard.spec.ts`
     header case with `req.user` undefined); mutation probes in the F14 PR body.
     Bump `_meta.json`: `activeCount` +1, `nextId` → `50` with a note that L-042..L-049 are
     pre-allocated to Wave A batches (SEQUENCE §4 — the first PR to land does this), `updatedAt`.
3. **`status/F14.jsonl`**: T1 rows (B52 B132 B133 B165 B168) → `state: "fixed"` with `proof` =
   the spec file(s) and `pr` once known; T2 rows (B138 B155) → `state: "proven-pending-deploy"`
   with `proof` = `31-impersonation-signout` / `32-active-sessions` and `evidence` naming the
   companion jest tests. A skip in the post-deploy run is NOT a discharge (L-041).

---

## 3. Mutation probes (run each: apply, run the named test with `-t`, confirm RED, restore)

| #   | File                            | Mutation                                                                               | Test that must go red                                                                        |
| --- | ------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| M1  | `uploads.controller.ts`         | delete the `"supplier-statements"` `OWNER_LOOKUPS` entry (default-deny still in place) | T2 `REG-B52 the owning tenant reads…` (403 + lookup not called); T1's `findUnique` assertion |
| M2  | `uploads.controller.ts`         | delete the default-deny block                                                          | T5 `REG-B52 unmapped prefixes and flat keys…` ((a)(b) 200, (c) 404)                          |
| M3  | `uploads.controller.ts`         | move the default-deny block to after `fs.existsSync`                                   | T5 (c) → 404, (e) `existsSync` called                                                        |
| M4  | `uploads.controller.ts`         | drop `caller?.role !== "SUPER_ADMIN"` from the default-deny                            | T4 pin (SUPER_ADMIN reads `legacy-prefix/` → 403)                                            |
| M5  | `uploads.controller.ts`         | change the owner branch `if (!owner \|\| …)` to `if (owner && …)`                      | T3 `REG-B52 a missing or NULL-tenant scan row fails closed`                                  |
| M6  | `customers.controller.ts`       | restore `UserRole.DRIVER` on `upsertCustomerPrice`                                     | T7 `REG-B132 upsertCustomerPrice declares…`                                                  |
| M7  | `customers.service.ts`          | delete the hoisted role gate                                                           | T8 inverted test + `REG-B132 a DRIVER posting a tier is refused…`                            |
| M8  | `customers.service.ts`          | move the role gate below `customerPrice.findUnique`                                    | T8 `findUnique not called` assertion                                                         |
| M9  | `order-templates.controller.ts` | restore DRIVER on any of create/update/addItem/removeItem                              | T9 `REG-B133 every mutation declares roles and none admits DRIVER`                           |
| M10 | `order-templates.controller.ts` | `addItem` calls `this.service.addItem(templateId, dto)`                                | T10 `REG-B133 addItem delegates to the ownership wrapper`                                    |
| M11 | `order-templates.service.ts`    | `addItemForUser` skips `findOneForUser`                                                | T11 `REG-B133 a CUSTOMER who does not own the template cannot add items`                     |
| M12 | `inventory.controller.ts`       | restore `@Roles(OPERATOR, DRIVER)` on `recordAdjustment`                               | T12 `REG-B168 every inventory write resolves to exactly [OPERATOR]`                          |
| M13 | `jwt.strategy.ts`               | remove the `impersonatedBy` line                                                       | T14 `REG-B165 REG-B138 the staff strategy passes impersonatedBy through`                     |
| M14 | `buyer-jwt.strategy.ts`         | revert to the 3-field literal                                                          | T14 `REG-B165 the buyer strategy passes impersonatedBy through`                              |
| M15 | `audit.interceptor.ts`          | omit `impersonatedBy` from `log({...})`                                                | T15 both REG-B165 cases                                                                      |
| M16 | `audit.service.ts`              | drop `impersonatedBy` from `create` data                                               | T16 both REG-B165 cases                                                                      |
| M17 | `impersonation.guard.ts`        | `readClaims` returns only `request.user ?? null` (no header decode)                    | T17 `REG-B165 a POST with impersonatedBy in the bearer token logs…`                          |
| M18 | `auth.controller.ts`            | remove the `if (user.impersonatedBy)` branch                                           | T18 `REG-B138 an impersonated caller's logout…`                                              |
| M19 | `auth.service.ts`               | restore `deleteMany` + unconditional `storeRefreshToken` (old rotation)                | T19 `REG-B155 rotates the stored row IN PLACE…` (`updateMany` never called)                  |
| M20 | `auth.service.ts`               | drop the `count === 0` fallback                                                        | T19 race pin (`upsert` not called)                                                           |
| M21 | `auth.service.ts`               | delete the inactive-branch `deleteMany`                                                | T19 inactive pin                                                                             |
| M22 | `auth.service.ts`               | add `createdAt: new Date()` to `updateMany.data`                                       | T19 key-absence assertion                                                                    |

Probe command shape:
`npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api test -- <spec file> -t "<test title fragment>"`.
Record each probe's red in the PR body per test id. A probe that stays green blocks the PR.

---

## 4. Post-deploy discharge (not part of this build's gates)

- Owner/lead before deploy: `railway run npx prisma migrate status` shows
  `20260908000000_campaign_schema_foundation` applied (R17/T25); DRIVER-role census + NULL-tenant
  supplier-statement scan count (spec §3); prod reseed `railway run --service postgres node apps/api/scripts/e2e-seed.js`
  (R15/T24) — paste the "Created … e2e_admin" / "exists" line into the PR.
- After merge + deploy the e2e suite fires off `deployment_status` by itself. Read the STEP
  conclusion and grep the log for `✓ … REG-B138` and `✓ … REG-B155` (L-041). A `skipped` spec 31
  leaves B138 at `proven-pending-deploy` with the skip reason recorded; it is never a discharge.
- Post-deploy smoke must include one bearer PDF fetch (`invoice-pdfs/`) and one signed image load
  (R2 blast radius).

---

## 5. Verification commands (scoped — never `npm run verify`, never Playwright)

Per round (after each implementation package):

```
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api test -- src/uploads/uploads-tenant-scope.security.spec.ts src/uploads/uploads-xss.security.spec.ts src/uploads/uploads-signed-url.security.spec.ts src/customers/customers.controller.roles.spec.ts src/customers/customers.service.spec.ts src/order-templates/order-templates.controller.roles.spec.ts src/order-templates/order-templates.service.spec.ts src/inventory/inventory.controller.roles.spec.ts src/auth/strategies/jwt.strategy.spec.ts src/audit/audit.interceptor.security.spec.ts src/audit/audit.service.spec.ts src/auth/guards/impersonation.guard.spec.ts src/auth/auth.controller.cookie.spec.ts src/auth/auth.service.spec.ts src/tenant/tenant-status.guard.spec.ts
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web run check-types
```

Final (before the PR):

```
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api run lint
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api test
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web run check-types
npm --prefix C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web run lint
npx prettier --check "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api/src/{uploads,customers,order-templates,inventory,auth,audit,buyer}/**/*.ts" "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/api/scripts/e2e-seed.js" "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web/app/(dashboard)/layout.tsx" "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web/app/(dashboard)/settings/page.tsx" "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web/lib/impersonation.ts" "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web/lib/i18n/messages.ts" "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web/e2e/**/*.ts" "C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/apps/web/playwright.config.ts"
node C:/ClaudeCode/routeflow/.claude/worktrees/rf-F14/scripts/validate-lessons.mjs
```

`npm --prefix …/apps/api test` is a real jest execution (not a turbo replay — L-034) and rewrites
`.campaign/runs/api.json` whole. `check-types` in `apps/api` excludes `*.spec.ts` (tsconfig) —
spec typing is enforced by ts-jest at run time, which is why the jest runs are part of every round.
