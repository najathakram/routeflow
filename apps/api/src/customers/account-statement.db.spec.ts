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
jest.mock("../invoices/invoice-pdf.service", () => ({ InvoicePdfService: jest.fn() }));
jest.mock("../vendor-bills/vendor-bills.service", () => ({ VendorBillsService: jest.fn() }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { randomUUID } from "crypto";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";
import { buildAccountStatement } from "./account-statement";
import { openBalancesByCustomer } from "./open-balances";
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
type OrderStatusName =
  | "PENDING"
  | "CONFIRMED"
  | "OUT_FOR_DELIVERY"
  | "PARTIALLY_DELIVERED"
  | "DELIVERED"
  | "REFUSED"
  | "CANCELLED";
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
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.tenantConfig.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seedTenant(label: string, opts: { walkIn?: boolean } = {}) {
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
        ...(opts.walkIn ? { isWalkIn: true } : {}),
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
    orderId: string | null = null,
    due = "2099-01-01",
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
        dueDate: new Date(`${due}T00:00:00.000Z`),
        ...(orderId ? { orderId } : {}),
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

  async function seedOrder(
    s: { tenantId: string; customerId: string },
    status: OrderStatusName,
    total: number,
  ) {
    const order = await prisma.order.create({
      data: { tenantId: s.tenantId, customerId: s.customerId, status, subtotal: total, total },
    });
    return order.id;
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
    // SA-1164 22:05Z (D3): an unpaid DRAFT on a DELIVERED order is receivable and every reader counts it; a paid-in-full one
    // adds 0 and is not a row; a DRAFT on a PENDING order is in none of them.
    const delivered = await seedOrder(s, "DELIVERED", 80);
    const deliveredPaid = await seedOrder(s, "DELIVERED", 60);
    const pending = await seedOrder(s, "PENDING", 70);
    await seedInvoice(s, "zdel", 80, [], "DRAFT", "2026-09-02", delivered);
    await seedInvoice(s, "zdelpaid", 60, [{ amount: 60 }], "DRAFT", "2026-09-02", deliveredPaid);
    await seedInvoice(s, "zpend", 70, [], "DRAFT", "2026-09-02", pending);

    const bookkeeping = new BookkeepingService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const EXPECTED = 1830.1; // 500 + 300 + 400 + 450 + 100 + 0.10 + 80 (the delivered DRAFT)

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
          ["zdel", 80],
        ],
      );
      expect(account.openInvoices.map((r) => r.paid)).toEqual([0, 200, 0, 0, 0, 1, 0]);
      expect(account.openInvoices.map((r) => r.credit)).toEqual([0, 0, 100, 50, 0, 0, 0]);
      // one object so a failure names every reader's cents at once
      expect({
        account: account.openBalance,
        operator: operator.outstandingAmount,
        mine: mine.outstandingAmount,
        summary: summary?.balance,
        aging: aging.totals.total,
      }).toEqual({
        account: EXPECTED,
        operator: EXPECTED,
        mine: EXPECTED,
        summary: EXPECTED,
        aging: EXPECTED,
      });
      // D3c: a counted DRAFT is never overdue, so it sits in the Current bucket (its due date is far out here; the
      // aging unit spec pins an old due date)
      expect(aging.buckets.current.map((e: any) => e.status)).toContain("DRAFT");
      expect(aging.buckets.current.find((e: any) => e.status === "DRAFT")?.balance).toBe(80);
      // and the rows are the whole answer
      expect(account.openInvoices.reduce((t, r) => Math.round((t + r.unpaid) * 100) / 100, 0)).toBe(
        EXPECTED,
      );
    });
  });

  it("F1: a delivered DRAFT past its due date is not late on the statement, while an issued invoice past the same date is", async () => {
    const s = await seedTenant("f1");
    const orderId = await seedOrder(s, "DELIVERED", 60);
    await seedInvoice(s, "sentlate", 100, [], "SENT", "2026-01-01", null, "2026-02-01");
    await seedInvoice(s, "draftlate", 60, [], "DRAFT", "2026-01-01", orderId, "2026-02-01");
    await tenantCtx.run(s.tenantId, async () => {
      const res = await buildAccountStatement(
        prisma,
        { id: s.customerId, businessName: "Acme f1", email: null },
        { staff: false },
      );
      expect(
        res.openInvoices.map((r) => [r.invoiceNumber.split("-").pop(), r.daysLate > 0]),
      ).toEqual([
        ["sentlate", true],
        ["draftlate", false],
      ]);
      expect(res.openInvoices[1].notSentYet).toBe(true);
      expect(res.openBalance).toBe(160);
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

  // SA-1164 21:13Z (PR-2b), rows Q1-Q6: a DRAFT invoice on a post-delivery order (DELIVERED or REFUSED) is a receivable;
  // every other DRAFT is not. One tenant per row; each reads the statement AND the customers-list figure.
  async function readBalance(s: { tenantId: string; customerId: string }) {
    return tenantCtx.run(s.tenantId, async () => {
      const statement = await buildAccountStatement(
        prisma,
        { id: s.customerId, businessName: "Acme q", email: null },
        { staff: true },
      );
      const list = await openBalancesByCustomer(prisma, [s.customerId], new Date());
      return {
        statementBalance: statement.openBalance,
        statementRows: statement.openInvoices.map((r) => [
          r.invoiceNumber.split("-").pop(),
          r.unpaid,
        ]),
        listBalance: list.get(s.customerId) ?? 0,
      };
    });
  }

  it("Q1: a DRAFT on a DELIVERED order, unpaid, counts on the statement and the customers list", async () => {
    const s = await seedTenant("q1");
    const orderId = await seedOrder(s, "DELIVERED", 120);
    await seedInvoice(s, "q1", 120, [], "DRAFT", "2026-09-01", orderId);
    const got = await readBalance(s);
    expect(got).toEqual({ statementBalance: 120, statementRows: [["q1", 120]], listBalance: 120 });
  });

  it("Q2: a fully paid DRAFT on a DELIVERED order is in the open set and adds 0 (the clamp)", async () => {
    const s = await seedTenant("q2");
    const orderId = await seedOrder(s, "DELIVERED", 120);
    await seedInvoice(s, "q2", 120, [{ amount: 120 }], "DRAFT", "2026-09-01", orderId);
    const got = await readBalance(s);
    // in the open set, but a 0.00 balance is no statement row (the statement's existing rule)
    expect(got).toEqual({ statementBalance: 0, statementRows: [], listBalance: 0 });
  });

  it("REFUSED counts like DELIVERED (POST_DELIVERY_ORDER_STATUSES)", async () => {
    const s = await seedTenant("refused");
    const orderId = await seedOrder(s, "REFUSED", 75.5);
    await seedInvoice(s, "rf", 75.5, [], "DRAFT", "2026-09-01", orderId);
    const got = await readBalance(s);
    expect(got).toEqual({
      statementBalance: 75.5,
      statementRows: [["rf", 75.5]],
      listBalance: 75.5,
    });
  });

  it.each([
    "PENDING",
    "CONFIRMED",
    "OUT_FOR_DELIVERY",
    "PARTIALLY_DELIVERED",
    "CANCELLED",
  ] as const)("Q3: a DRAFT on a %s order is not counted", async (orderStatus) => {
    const s = await seedTenant(`q3-${orderStatus.toLowerCase().replace(/_/g, "")}`);
    const orderId = await seedOrder(s, orderStatus, 120);
    await seedInvoice(s, "q3", 120, [], "DRAFT", "2026-09-01", orderId);
    const got = await readBalance(s);
    expect(got).toEqual({ statementBalance: 0, statementRows: [], listBalance: 0 });
  });

  it("Q4: a standalone DRAFT with no order is not counted", async () => {
    const s = await seedTenant("q4");
    await seedInvoice(s, "q4", 120, [], "DRAFT");
    const got = await readBalance(s);
    expect(got).toEqual({ statementBalance: 0, statementRows: [], listBalance: 0 });
  });

  it("Q5: a walk-in customer's DRAFT on a DELIVERED order counts on the statement (no carve-out)", async () => {
    const s = await seedTenant("q5", { walkIn: true });
    const orderId = await seedOrder(s, "DELIVERED", 40);
    await seedInvoice(s, "q5", 40, [], "DRAFT", "2026-09-01", orderId);
    const got = await readBalance(s);
    expect(got.statementBalance).toBe(40);
    expect(got.statementRows).toEqual([["q5", 40]]);
  });

  it("Q6: a DRAFT raised at a carrier shipment (order still open) is not counted; LATER row, named in the PR", async () => {
    const s = await seedTenant("q6");
    const orderId = await seedOrder(s, "OUT_FOR_DELIVERY", 1758);
    await seedInvoice(s, "q6", 1758, [], "DRAFT", "2026-09-01", orderId);
    const got = await readBalance(s);
    expect(got).toEqual({ statementBalance: 0, statementRows: [], listBalance: 0 });
  });

  it("a mixed customer: SENT 100 + DRAFT on DELIVERED 50 + DRAFT on PENDING 30, with VOID, PAID and WRITTEN_OFF on a delivered order, reads 150", async () => {
    const s = await seedTenant("mix");
    const delivered = await seedOrder(s, "DELIVERED", 50);
    const pending = await seedOrder(s, "PENDING", 30);
    await seedInvoice(s, "sent", 100, [], "SENT", "2026-08-01");
    await seedInvoice(s, "dd", 50, [], "DRAFT", "2026-08-02", delivered);
    await seedInvoice(s, "dp", 30, [], "DRAFT", "2026-08-03", pending);
    await seedInvoice(s, "void", 10, [], "VOID", "2026-08-04", delivered);
    await seedInvoice(s, "paid", 10, [{ amount: 10 }], "PAID", "2026-08-05", delivered);
    await seedInvoice(s, "wo", 10, [], "WRITTEN_OFF", "2026-08-06", delivered);
    const got = await readBalance(s);
    expect(got).toEqual({
      statementBalance: 150,
      statementRows: [
        ["sent", 100],
        ["dd", 50],
      ],
      listBalance: 150,
    });
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
