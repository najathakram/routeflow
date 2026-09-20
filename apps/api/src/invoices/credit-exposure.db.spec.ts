/**
 * B577 follow-up — DB-lane proof of `loadCreditExposure`'s edited-order reads against a REAL
 * Postgres: the extra OR branch (the edited order's own PAID invoices, whatever the order's status),
 * that `method` really comes back from the `payments` select (so a CREDIT_NOTE application is never
 * counted as cash), the unsettled floor, and tenant isolation. The mocked specs pin the query SHAPE;
 * only a real database proves the rows the shape returns.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`; the real
 * connection is built in `beforeAll` (never at collection time) and `requireLocalDatabaseUrl()`
 * refuses any non-local host. SAFETY: every tenant is a throwaway `qa-b577-<run>-<n>-<label>` slug
 * approved by `assertTestTenant`; `afterAll` deletes exactly the tenants THIS run created, in FK
 * order. Each test seeds its own tenant, so no expectation depends on a sibling.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { loadCreditExposure } from "./credit-exposure";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("loadCreditExposure — edited-order reads (B577 follow-up), real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch(() => undefined); // never mask a test's own result
    }
    await prisma?.$disconnect();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A fresh tenant + customer + DELIVERED order (a status the covering OR branch would NOT read). */
  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(`qa-b577-${RUN}-${seq}-${label}`, "credit-exposure.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `B577 ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `B577 ${label}`,
        contactName: label,
        tenantId: tenant.id,
      },
    });
    const order = await prisma.order.create({
      data: { tenantId: tenant.id, customerId: customer.id, status: "DELIVERED", total: 100 },
    });
    return { tenantId: tenant.id, customerId: customer.id, orderId: order.id };
  }

  async function invoice(
    s: { tenantId: string; customerId: string; orderId: string },
    label: string,
    status: "PAID" | "SENT" | "OVERDUE",
    total: number,
    payments: Array<{
      amount: number;
      method: "CASH" | "CREDIT_NOTE" | "ADVANCE";
      status?: "PAID" | "PENDING";
    }> = [],
    orderId: string | null = s.orderId,
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        orderId,
        invoiceNumber: `INV-B577-${RUN}-${label}`,
        status,
        subtotal: total,
        total,
      },
    });
    for (const p of payments)
      await prisma.invoicePayment.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: inv.id,
          amount: p.amount,
          method: p.method,
          status: p.status ?? "PAID",
        },
      });
    return inv;
  }

  const load = (s: { tenantId: string; customerId: string }, excludeOrderId?: string) =>
    tenantCtx.run(s.tenantId, () =>
      loadCreditExposure(prisma.forTenant(), s.customerId, { excludeOrderId }),
    );

  it("the edited order's PAID invoice is read even though its order is DELIVERED (the extra OR branch); without excludeOrderId it is not, and the four-figure shape is unchanged", async () => {
    const s = await seed("or-branch");
    await invoice(s, "a", "PAID", 100, [{ amount: 100, method: "CASH" }]);

    const edited = await load(s, s.orderId);
    expect(edited.excludedOrderPaid).toBe(100);
    expect(edited.counted).toBe(0); // the edited order's invoices never enter the other buckets

    const plain = await load(s);
    expect(Object.keys(plain).sort()).toEqual(
      ["counted", "invoiceExposure", "pendingExposure", "uninvoicedOrderExposure"].sort(),
    );
  });

  it("`method` round-trips from Postgres: a CREDIT_NOTE application is not received money; cash and ADVANCE are; a PENDING payment is nothing", async () => {
    const s = await seed("method");
    await invoice(s, "cn", "PAID", 100, [{ amount: 100, method: "CREDIT_NOTE" }]);
    expect((await load(s, s.orderId)).excludedOrderPaid).toBe(0);

    const t = await seed("method-cash");
    await invoice(t, "mix", "PAID", 100, [
      { amount: 30, method: "CASH" },
      { amount: 20, method: "ADVANCE" },
      { amount: 50, method: "CREDIT_NOTE" },
      { amount: 99, method: "CASH", status: "PENDING" },
    ]);
    expect((await load(t, t.orderId)).excludedOrderPaid).toBe(50);
  });

  it("the unsettled floor is the SENT / OVERDUE balance of the edited order's invoices — and another tenant's invoice for the same customer id is never read", async () => {
    const s = await seed("floor");
    await invoice(s, "s", "SENT", 60);
    await invoice(s, "o", "OVERDUE", 40, [{ amount: 10, method: "CASH" }]);
    const r = await load(s, s.orderId);
    expect(r.excludedOrderUnsettledOutstanding).toBe(90); // 60 + (40 - 10)
    expect(r.excludedOrderPaid).toBe(10);

    // an invoice in ANOTHER tenant naming this customer must not leak in (tenant scoping)
    const other = await seed("floor-other");
    await prisma.invoice.create({
      data: {
        tenantId: other.tenantId,
        customerId: s.customerId,
        orderId: s.orderId,
        invoiceNumber: `INV-B577-${RUN}-leak`,
        status: "SENT",
        subtotal: 1000,
        total: 1000,
      },
    });
    expect((await load(s, s.orderId)).excludedOrderUnsettledOutstanding).toBe(90);
  });
});
