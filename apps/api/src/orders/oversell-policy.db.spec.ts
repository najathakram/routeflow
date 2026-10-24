/**
 * WS9 oversell policy against a REAL Postgres (WRITTEN, NOT RUN on the PC): through the real
 * `PolicyService` + `PolicyOversellReader` + `resolveOversellAllowed` and the real
 * `decrementStockForSale` inside a real tenant transaction (the FOR UPDATE row lock included).
 *
 *  - stock 5, two CONCURRENT buyer orders of 3: policy off -> exactly one succeeds, the other gets the
 *    coded INSUFFICIENT_STOCK 409, stock ends at 2; policy backorder -> both succeed, stock ends at -1.
 *  - two tenants: A backorder (PolicyService.set), B off: isolation.
 *  - a CUSTOMER-scope override via PolicyService.set wins over the tenant value, per customer.
 *  - the policy write is append-only (supersede) and audited (`policy.set` row).
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. Every tenant
 * is a throwaway `qa-oversell-*` slug approved by assertTestTenant; afterAll deletes exactly what this
 * run created. Follows order-stock-b920.db.spec.ts (stock) and policy.service.db.spec.ts (policy).
 */
import { randomUUID } from "crypto";
import { ConflictException, Logger } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { PolicyService } from "../policy/policy.service";
import { PolicyOversellReader } from "./policy-oversell-reader";
import { resolveOversellAllowed } from "./oversell-policy";
import { decrementStockForSale } from "./order-stock";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const KEY = "orders.buyerOversell";
const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("WS9 buyer oversell policy: real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let policies: PolicyService;
  let reader: PolicyOversellReader;
  const tenantIds: string[] = [];
  const actor = { id: null, name: "qa-admin", impersonatedBy: null };

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    policies = new PolicyService(prisma);
    reader = new PolicyOversellReader(policies);
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch((e) => {
        console.warn(`oversell-policy.db.spec: cleanup of ${tenantId} failed: ${e}`);
      });
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
  }, 120_000);

  async function cleanup(tenantId: string): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.policyValue.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A fresh qa-* tenant with a product on hand and two customers. */
  async function seed(stock = "5") {
    seq += 1;
    const slug = assertTestTenant(`qa-oversell-${RUN}-${seq}`, "oversell-policy.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `Oversell ${slug}` } });
    tenantIds.push(tenant.id);
    const customers: string[] = [];
    for (const n of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      const user = await prisma.user.create({
        data: {
          email: `${slug}-${n}@example.invalid`,
          username: `${slug}-${n}`,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      const c = await prisma.customer.create({
        data: {
          userId: user.id,
          businessName: `Acme ${seq}-${n}`,
          contactName: "c",
          tenantId: tenant.id,
        },
      });
      customers.push(c.id);
    }
    const product = await prisma.product.create({
      data: {
        name: `Mango ${RUN}-${seq}`,
        unit: "each",
        pricePerUnit: "1.00",
        currentStock: stock,
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, productId: product.id, customers };
  }

  const setPolicy = (
    tenantId: string,
    value: string,
    scope: { scopeType: "TENANT" | "CUSTOMER"; scopeId?: string } = { scopeType: "TENANT" },
  ) =>
    tenantCtx.run(tenantId, () =>
      policies.set({ tenantId, key: KEY, reason: "qa", actor, value, ...scope }),
    );

  /** One buyer order: resolve the policy BEFORE the transaction, then lock + decrement. */
  const buyerOrder = (
    t: { tenantId: string; productId: string },
    customerId: string,
    qty: number,
    orderId = randomUUID(),
  ) =>
    tenantCtx.run(t.tenantId, async () => {
      const allowOversell = await resolveOversellAllowed(reader, {
        tenantId: t.tenantId,
        role: UserRole.CUSTOMER,
        source: "buyer",
        customerId,
      });
      return prisma.tenantTransaction(async (tx: any) => {
        await decrementStockForSale(
          { logger: new Logger("oversell-policy.db.spec"), tenantId: t.tenantId },
          tx,
          [{ productId: t.productId, qty }],
          allowOversell,
          { orderId, notes: "CREATE", performedById: null },
        );
      });
    });

  const stockNow = async (productId: string) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

  const settle = (ps: Promise<unknown>[]) => Promise.allSettled(ps);

  it("policy off: two concurrent buyer orders of 3 against 5 -> exactly one succeeds, the other gets the coded 409", async () => {
    const t = await seed();
    const r = await settle([buyerOrder(t, t.customers[0], 3), buyerOrder(t, t.customers[1], 3)]);
    const ok = r.filter((x) => x.status === "fulfilled");
    const bad = r.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(ConflictException);
    // Plain message on a base without #2871's coded body; a coded body still matches by message.
    expect(JSON.stringify((bad[0].reason as ConflictException).getResponse())).toMatch(
      /insufficient stock/i,
    );
    expect(await stockNow(t.productId)).toBe(2);
  }, 120_000);

  it("policy backorder: both succeed and stock ends at -1 (FOR UPDATE serialises the two decrements)", async () => {
    const t = await seed();
    await setPolicy(t.tenantId, "backorder");
    const r = await settle([buyerOrder(t, t.customers[0], 3), buyerOrder(t, t.customers[1], 3)]);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await stockNow(t.productId)).toBe(-1);
    expect(await prisma.stockMovement.count({ where: { productId: t.productId } })).toBe(2);
  }, 120_000);

  it("two tenants are isolated: A backorder (set), B off (never set)", async () => {
    const a = await seed();
    const b = await seed();
    await setPolicy(a.tenantId, "backorder");
    await expect(buyerOrder(a, a.customers[0], 6)).resolves.toBeUndefined();
    expect(await stockNow(a.productId)).toBe(-1);
    await expect(buyerOrder(b, b.customers[0], 6)).rejects.toBeInstanceOf(ConflictException);
    expect(await stockNow(b.productId)).toBe(5);
  }, 120_000);

  it("a CUSTOMER-scope override (PolicyService.set) wins over the tenant value, per customer", async () => {
    const t = await seed();
    await setPolicy(t.tenantId, "off");
    await setPolicy(t.tenantId, "backorder", { scopeType: "CUSTOMER", scopeId: t.customers[0] });
    await expect(buyerOrder(t, t.customers[0], 6)).resolves.toBeUndefined(); // c1 may backorder
    expect(await stockNow(t.productId)).toBe(-1);
    await expect(buyerOrder(t, t.customers[1], 1)).rejects.toBeInstanceOf(ConflictException); // c2: off
    expect(await stockNow(t.productId)).toBe(-1);

    // and the reverse: tenant backorder, c2 pinned off
    const u = await seed();
    await setPolicy(u.tenantId, "backorder");
    await setPolicy(u.tenantId, "off", { scopeType: "CUSTOMER", scopeId: u.customers[1] });
    await expect(buyerOrder(u, u.customers[1], 6)).rejects.toBeInstanceOf(ConflictException);
    await expect(buyerOrder(u, u.customers[0], 6)).resolves.toBeUndefined();
  }, 120_000);

  it("the policy write is append-only (supersede, never update/delete) and audited", async () => {
    const t = await seed();
    await setPolicy(t.tenantId, "backorder");
    await setPolicy(t.tenantId, "off");
    const rows = await prisma.policyValue.findMany({
      where: { tenantId: t.tenantId, key: KEY },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2); // history kept
    expect(rows[0].supersededAt).not.toBeNull();
    expect(rows[0].supersededById).toBe(rows[1].id);
    expect(rows[1].supersededAt).toBeNull();
    expect(rows.map((r) => r.value)).toEqual(["backorder", "off"]);
    const audit = await prisma.auditLog.findMany({
      where: { tenantId: t.tenantId, entityType: "PolicyValue", action: "policy.set" },
    });
    expect(audit).toHaveLength(2);
    // the NEW value now wins on a fresh read
    await expect(buyerOrder(t, t.customers[0], 6)).rejects.toBeInstanceOf(ConflictException);
  }, 120_000);
});
