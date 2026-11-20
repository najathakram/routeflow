/**
 * SA-1197 T13 (S9, same cents everywhere) and T17 (scope), against real Postgres.
 *
 * T13: the invoice's open balance equals the operator statement's outstanding and the customers-list figure to the
 * cent, with an overpaid sibling, a receivable DRAFT sibling, and PAID / VOID / WRITTEN_OFF siblings. The model is read
 * with the PDF / send include (SEND_SNAPSHOT_INCLUDE), so `isWalkIn` arrives the way production reads it.
 * T17: another customer's and another tenant's open invoices are never summed.
 *
 * Collected only by `jest.db.config.js`, run via `npm run local:test:db`; `requireLocalDatabaseUrl()` refuses any
 * non-local host. SAFETY: every tenant is a throwaway `qa-sa1197-<run>-<n>-<label>` slug approved by `assertTestTenant`;
 * `afterAll` deletes exactly the rows THIS run created, in FK order.
 */
import { randomUUID } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SEND_SNAPSHOT_INCLUDE } from "../invoices/invoice-send-snapshot";
import { openBalancesByCustomer } from "./open-balances";
import { buildOperatorStatement } from "./customer-statement";
import { readInvoiceAccountBalance } from "./invoice-account-balance";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("invoice account block (SA-1197), real Postgres", () => {
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
    for (const tenantId of [...tenantIds].reverse()) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch((e) => {
        console.warn(`invoice-account-balance.db.spec: cleanup of tenant ${tenantId} failed: ${e}`);
      });
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

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa1197-${RUN}-${seq}-${label}`,
      "invoice-account-balance.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA1197 ${slug}` } });
    tenantIds.push(tenant.id);
    return tenant.id;
  }

  async function seedCustomer(tenantId: string, label: string, isWalkIn = false) {
    seq += 1;
    const handle = `qa-sa1197-${RUN}-${seq}-${label}`;
    const user = await prisma.user.create({
      data: { email: `${handle}@example.invalid`, username: handle, role: "CUSTOMER", tenantId },
    });
    const c = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `Acme ${label}`,
        contactName: `Acme ${label}`,
        tenantId,
        ...(isWalkIn ? { isWalkIn: true } : {}),
      } as any,
    });
    return c.id;
  }

  async function seedInvoice(
    tenantId: string,
    customerId: string,
    label: string,
    total: number,
    opts: {
      status?: "SENT" | "PARTIAL" | "PAID" | "DRAFT" | "VOID" | "WRITTEN_OFF";
      paid?: number;
      orderId?: string;
    } = {},
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-SA1197-${RUN}-${label}`,
        status: opts.status ?? "SENT",
        subtotal: total,
        total,
        issueDate: new Date("2026-11-01T00:00:00.000Z"),
        dueDate: new Date("2099-01-01T00:00:00.000Z"),
        ...(opts.orderId ? { orderId: opts.orderId } : {}),
      },
    });
    if (opts.paid)
      await prisma.invoicePayment.create({
        data: { tenantId, invoiceId: inv.id, amount: opts.paid, method: "CASH", status: "PAID" },
      });
    return inv.id;
  }

  it("T13 + T17: the invoice's open balance is the statement's and the customers list's, to the cent, and only this customer's", async () => {
    const t = await seedTenant("main");
    const other = await seedTenant("other");
    const cust = await seedCustomer(t, "main");
    const neighbour = await seedCustomer(t, "neighbour");
    const stranger = await seedCustomer(other, "stranger");

    const thisId = await seedInvoice(t, cust, "this", 50, { status: "PARTIAL", paid: 10.1 });
    await seedInvoice(t, cust, "open", 30.2);
    await seedInvoice(t, cust, "overpaid", 20, { paid: 25 }); // counts 0, never nets the others down
    const delivered = await prisma.order.create({
      data: { tenantId: t, customerId: cust, status: "DELIVERED", subtotal: 80, total: 80 },
    });
    await seedInvoice(t, cust, "rdraft", 80, { status: "DRAFT", orderId: delivered.id }); // receivable DRAFT
    await seedInvoice(t, cust, "draft", 70, { status: "DRAFT" }); // not receivable
    await seedInvoice(t, cust, "paid", 100, { status: "PAID", paid: 100 });
    await seedInvoice(t, cust, "void", 100, { status: "VOID" });
    await seedInvoice(t, cust, "wo", 100, { status: "WRITTEN_OFF" });
    await seedInvoice(t, neighbour, "neighbour", 999); // T17: same tenant, another customer
    await seedInvoice(other, stranger, "stranger", 777); // T17: another tenant

    await tenantCtx.run(t, async () => {
      const model = await prisma.forTenant().invoice.findUnique({
        where: { id: thisId },
        include: SEND_SNAPSHOT_INCLUDE,
      });
      expect(model?.customer).toHaveProperty("isWalkIn", null);
      const r = await readInvoiceAccountBalance(
        prisma,
        model as never,
        { showAccountBalance: true },
        new Date(),
      );
      const statement: any = await buildOperatorStatement(prisma, cust);
      const list = await openBalancesByCustomer(prisma, [cust], new Date());

      if (!r.show) throw new Error("expected the block");
      expect(r.thisInvoice).toBe(39.9); // 50 - 10.10
      expect(r.others).toBe(110.2); // 30.20 + 0 (overpaid) + 80 (receivable DRAFT)
      expect(r.openBalance).toBe(150.1);
      expect(r.openBalance).toBe(statement.outstandingAmount);
      expect(r.openBalance).toBe(list.get(cust));
    });
  });

  it("T9: a real walk-in customer's invoice gets no block", async () => {
    const t = await seedTenant("walkin");
    const walkIn = await seedCustomer(t, "walkin", true);
    const thisId = await seedInvoice(t, walkIn, "w1", 10);
    await seedInvoice(t, walkIn, "w2", 20);
    await tenantCtx.run(t, async () => {
      const model = await prisma.forTenant().invoice.findUnique({
        where: { id: thisId },
        include: SEND_SNAPSHOT_INCLUDE,
      });
      expect(
        await readInvoiceAccountBalance(prisma, model as never, { showAccountBalance: true }),
      ).toEqual({ show: false });
    });
  });
});
