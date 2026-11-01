/**
 * SA-1078 PR-1 (W-1096), rows S9, S13 (the window's edges) and S18 (another tenant's customer), against real Postgres.
 *
 * S9: ONE customer holding the whole of S4 to S7 reads the same cents through every reader of what a customer owes:
 * the operator statement, the buyer's statement (the same builder, the buyer route), `buildMyStatement`, the account
 * statement, the Customer Balance Summary and AR aging. The unit specs pin the arithmetic; this proves the real queries
 * hand the same rows to it.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`; the real connection is built
 * in `beforeAll` and `requireLocalDatabaseUrl()` refuses any non-local host. SAFETY: every tenant is a throwaway
 * `qa-sa1078-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the rows THIS run
 * created, in FK order. Each test seeds its own tenant, so no expectation depends on a sibling.
 */
jest.mock("../bookkeeping/invoice.service", () => ({ InvoiceService: jest.fn() }));
jest.mock("../vendor-bills/vendor-bills.service", () => ({ VendorBillsService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";
import { buildAccountStatement } from "./account-statement";
import { buildMyStatement, buildOperatorStatement } from "./customer-statement";
import { CustomersService } from "./customers.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

type Pay = {
  amount: number;
  method?: "CASH" | "CHECK" | "CREDIT_NOTE" | "ADVANCE";
  status?: "DRAFT" | "PAID" | "VOID" | "PENDING";
  paidAt?: Date;
  settledAt?: Date | null;
};
type Status = "SENT" | "PARTIAL" | "PAID" | "DRAFT" | "VOID" | "WRITTEN_OFF";

describeDb("account statement (SA-1078), real Postgres", () => {
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
        console.warn(`account-statement.db.spec: cleanup of tenant ${tenantId} failed: ${e}`);
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await prisma.invoicePayment.deleteMany({ where: { tenantId } });
    await prisma.creditNote.deleteMany({ where: { tenantId } });
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.tenantConfig.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa1078-${RUN}-${seq}-${label}`,
      "account-statement.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `SA1078 ${slug}` } });
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
        businessName: `Acme ${label}`,
        contactName: label,
        email: `ap-${slug}@example.invalid`,
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, customerId: customer.id, userId: user.id };
  }

  async function seedInvoice(
    s: { tenantId: string; customerId: string },
    label: string,
    total: number,
    payments: Pay[] = [],
    status: Status = "SENT",
    issue = "2026-09-01",
  ) {
    const inv = await prisma.invoice.create({
      data: {
        tenantId: s.tenantId,
        customerId: s.customerId,
        invoiceNumber: `INV-SA1078-${RUN}-${label}`,
        status,
        subtotal: total,
        total,
        issueDate: new Date(`${issue}T00:00:00.000Z`),
        dueDate: new Date("2099-01-01T00:00:00.000Z"),
      },
    });
    for (const p of payments)
      await prisma.invoicePayment.create({
        data: {
          tenantId: s.tenantId,
          invoiceId: inv.id,
          amount: p.amount,
          method: p.method ?? "CASH",
          status: p.status ?? "PAID",
          ...(p.paidAt ? { paidAt: p.paidAt } : {}),
          ...(p.settledAt !== undefined ? { settledAt: p.settledAt } : {}),
        },
      });
    return inv.id;
  }

  function customersService(): CustomersService {
    const svc = Object.create(CustomersService.prototype) as CustomersService;
    (svc as any).prisma = prisma;
    return svc;
  }

  it("S9: one fixture of S4 to S7 reads the same cents through every reader of what a customer owes", async () => {
    const s = await seedTenant("s9");
    // S4: four rows over one customer
    await seedInvoice(s, "a", 500, [], "SENT", "2026-08-01");
    await seedInvoice(s, "b", 500, [{ amount: 200 }], "PARTIAL", "2026-08-02");
    await seedInvoice(s, "c", 500, [{ amount: 100, method: "CREDIT_NOTE" }], "SENT", "2026-08-03");
    await seedInvoice(s, "d", 500, [{ amount: 50, method: "ADVANCE" }], "SENT", "2026-08-04");
    // S5: a DRAFT payment and a VOID payment are not money
    await seedInvoice(s, "e", 100, [
      { amount: 40, status: "DRAFT" },
      { amount: 30, status: "VOID" },
    ]);
    // S6: none of these is a row
    await seedInvoice(s, "draft", 100, [], "DRAFT");
    await seedInvoice(s, "paid", 100, [{ amount: 100 }], "PAID");
    await seedInvoice(s, "void", 100, [], "VOID");
    await seedInvoice(s, "wo", 100, [], "WRITTEN_OFF");
    await seedInvoice(s, "exact", 100, [{ amount: 100 }]);
    // S7: float dust: three lines of 0.10 paid 0.30 in parts, and a 1.10 invoice paid in ten dimes
    await seedInvoice(s, "dust", 0.3, [{ amount: 0.1 }, { amount: 0.1 }, { amount: 0.1 }]);
    await seedInvoice(
      s,
      "dimes",
      1.1,
      Array.from({ length: 10 }, () => ({ amount: 0.1 })),
    );

    const bookkeeping = new BookkeepingService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const EXPECTED = 1750.1; // 500 + 300 + 400 + 450 + 100 + 0.10

    await tenantCtx.run(s.tenantId, async () => {
      const buyer = { sub: s.userId, role: "CUSTOMER" } as any;
      const account = await buildAccountStatement(
        prisma,
        { id: s.customerId, businessName: "Acme s9", email: null },
        { staff: true },
      );
      const operator: any = await buildOperatorStatement(prisma, s.customerId);
      const mine: any = await buildMyStatement(prisma, buyer);
      const summary = (await bookkeeping.getCustomerBalanceSummary()).data.find(
        (r: any) => r.customerId === s.customerId,
      );
      const aging: any = await bookkeeping.getArAgingInvoices();

      expect(account.openInvoices.map((r) => [r.invoiceNumber.split("-").pop(), r.unpaid])).toEqual(
        [
          ["a", 500],
          ["b", 300],
          ["c", 400],
          ["d", 450],
          ["e", 100],
          ["dimes", 0.1],
        ],
      );
      expect(account.openInvoices.map((r) => r.paid)).toEqual([0, 200, 0, 0, 0, 1]);
      expect(account.openInvoices.map((r) => r.credit)).toEqual([0, 0, 100, 50, 0, 0]);
      expect(account.openBalance).toBe(EXPECTED);
      expect(operator.outstandingAmount).toBe(EXPECTED);
      expect(mine.outstandingAmount).toBe(EXPECTED);
      expect(summary?.balance).toBe(EXPECTED);
      expect(aging.totals.total).toBe(EXPECTED);
      // and the rows are the whole answer
      expect(account.openInvoices.reduce((t, r) => Math.round((t + r.unpaid) * 100) / 100, 0)).toBe(
        EXPECTED,
      );
    });
  });

  it("S13: the 30-day window — day 30 in, day 31 out, DRAFT and VOID out, a paid invoice's payment in, dated by collection", async () => {
    const s = await seedTenant("s13");
    const now = new Date("2026-10-31T15:00:00.000Z"); // a UTC tenant: today is 2026-10-31, the window opens 2026-10-01
    const at = (iso: string) => new Date(iso);
    await seedInvoice(s, "w", 1000, [
      { amount: 11, paidAt: at("2026-10-01T00:00:00.000Z") }, // day 30: in
      { amount: 12, paidAt: at("2026-09-30T23:59:59.000Z") }, // day 31: out
      { amount: 13, status: "DRAFT", paidAt: at("2026-10-30T10:00:00.000Z") }, // out
      { amount: 14, status: "VOID", paidAt: at("2026-10-30T11:00:00.000Z") }, // out
      {
        amount: 15,
        method: "CHECK",
        paidAt: at("2026-09-10T00:00:00.000Z"),
        settledAt: at("2026-10-28T00:00:00.000Z"), // recorded long ago, collected 3 days ago: in, dated Oct 28
      },
      {
        amount: 16,
        method: "CHECK",
        paidAt: at("2026-10-29T00:00:00.000Z"),
        settledAt: at("2026-09-20T00:00:00.000Z"), // collected before the window: out
      },
    ]);
    await seedInvoice(s, "p", 40, [{ amount: 40, paidAt: at("2026-10-20T09:00:00.000Z") }], "PAID");

    jest.useFakeTimers({
      now,
      doNotFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "nextTick",
        "queueMicrotask",
        "performance",
      ],
    });
    try {
      await tenantCtx.run(s.tenantId, async () => {
        const res = await buildAccountStatement(
          prisma,
          { id: s.customerId, businessName: "Acme s13", email: null },
          { staff: false },
        );
        expect(res.asOf).toBe("2026-10-31");
        expect(res.recentPayments.map((p) => [p.amount, p.date.slice(0, 10)])).toEqual([
          [15, "2026-10-28"],
          [40, "2026-10-20"],
          [11, "2026-10-01"],
        ]);
        expect(res.recentPayments.find((p) => p.amount === 40)?.invoiceNumber).toMatch(/-p$/);
        expect(res.recentPaymentsTruncated).toBe(false);
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("S18: another tenant's customer is a 404 on the staff read, and nothing of it leaks", async () => {
    const mine = await seedTenant("s18a");
    const theirs = await seedTenant("s18b");
    await seedInvoice(theirs, "x", 999);
    await tenantCtx.run(mine.tenantId, async () => {
      await expect(
        customersService().getAccountStatement(theirs.customerId, { staff: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      // and the same id through the builder directly sees none of their invoices (every read is tenant-scoped)
      const direct = await buildAccountStatement(
        prisma,
        { id: theirs.customerId, businessName: "x", email: null },
        { staff: true },
      );
      expect(direct.openInvoices).toEqual([]);
      expect(direct.openBalance).toBe(0);
    });
  });
});
