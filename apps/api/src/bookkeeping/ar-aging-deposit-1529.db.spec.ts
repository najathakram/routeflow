/**
 * #1529 (B87) / SA-517 PR-A — AR aging's deposit visibility against real Postgres. The unit spec
 * (ar-aging-deposit-1529.spec.ts) pins the math; this proves the REAL query hands the deposit
 * columns to it: an invoice whose deposit is overdue but whose dueDate is ahead stays in the
 * CURRENT bucket, carries depositOverdue, and is counted in the top-level depositOverdue summary;
 * totals keep exactly their bucket keys.
 *
 * SAFETY: every row lives under one throwaway `qa-b1529-<sfx>` tenant (`assertTestTenant`);
 * `afterAll` deletes exactly those rows in FK order. Collected only by `jest.db.config.js` — run via
 * `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// Loading the real InvoiceService pulls in @react-pdf/renderer (ESM-only); AR aging never uses it.
jest.mock("./invoice.service", () => ({ InvoiceService: jest.fn() }));
jest.mock("../vendor-bills/vendor-bills.service", () => ({ VendorBillsService: jest.fn() }));

import { BookkeepingService } from "./bookkeeping.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "ar-aging-deposit-1529.db.spec.ts";
const sfx = randomUUID().slice(0, 8);
const TENANT = `qa-b1529-${sfx}-tenant`;
const SLUG = assertTestTenant(`qa-b1529-${sfx}`, SPEC);
const USER = randomUUID();
const CUSTOMER = randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const dayStamp = (offsetDays: number) =>
  new Date(`${new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`);

describeDb("#1529 AR aging surfaces overdue deposits (real Postgres)", () => {
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let service: BookkeepingService;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const unused = {} as any; // AR aging touches only prisma
    service = new BookkeepingService(prisma, unused, unused, unused, unused, unused, unused);

    await prisma.tenant.create({ data: { id: TENANT, slug: SLUG, name: `ACME ${SLUG}` } });
    await prisma.user.create({
      data: {
        id: USER,
        email: `${USER}@example.invalid`,
        username: USER,
        role: "CUSTOMER",
        tenantId: TENANT,
      },
    });
    await prisma.customer.create({
      data: {
        id: CUSTOMER,
        userId: USER,
        businessName: "Acme Deli",
        contactName: "Sample Contact",
        tenantId: TENANT,
      },
    });
    const base = { customerId: CUSTOMER, tenantId: TENANT, status: "SENT" as const };
    await prisma.invoice.createMany({
      data: [
        // overdue deposit (50% of 1000, due 10 days ago, nothing paid), invoice due in 30 days
        {
          ...base,
          invoiceNumber: `INV-${sfx}-1`,
          subtotal: 1000,
          total: 1000,
          dueDate: dayStamp(30),
          depositPercent: 50,
          depositDueDate: dayStamp(-10),
        },
        // deposit not yet due
        {
          ...base,
          invoiceNumber: `INV-${sfx}-2`,
          subtotal: 400,
          total: 400,
          dueDate: dayStamp(30),
          depositPercent: 25,
          depositDueDate: dayStamp(5),
        },
        // no deposit
        {
          ...base,
          invoiceNumber: `INV-${sfx}-3`,
          subtotal: 200,
          total: 200,
          dueDate: dayStamp(30),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.invoicePayment
      .deleteMany({ where: { invoice: { tenantId: TENANT } } })
      .catch(() => undefined);
    await prisma.invoice.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
    await prisma.customer.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
    await prisma.tenantConfig.deleteMany({ where: { tenantId: TENANT } }).catch(() => undefined);
    await prisma.tenant.deleteMany({ where: { id: TENANT } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("#1529: the overdue deposit rides its CURRENT row and the top-level summary; totals keep their bucket keys", async () => {
    const result: any = await tenantCtx.run(TENANT, () => service.getArAgingInvoices());
    const byNumber = Object.fromEntries(
      result.buckets.current.map((e: any) => [e.invoiceNumber, e]),
    );
    expect(Object.keys(byNumber).sort()).toEqual([`INV-${sfx}-1`, `INV-${sfx}-2`, `INV-${sfx}-3`]);
    expect(byNumber[`INV-${sfx}-1`]).toMatchObject({ depositAmount: 500, depositOverdue: true });
    expect(byNumber[`INV-${sfx}-2`]).toMatchObject({ depositAmount: 100, depositOverdue: false });
    expect(byNumber[`INV-${sfx}-3`]).toMatchObject({
      depositAmount: null,
      depositDueDate: null,
      depositOverdue: false,
    });
    expect(result.depositOverdue).toEqual({ count: 1, outstanding: 500 });
    expect(Object.keys(result.totals).sort()).toEqual(
      ["current", "days1_30", "days31_60", "days61_90", "days90plus", "total"].sort(),
    );
    expect(result.totals.current).toBe(1600);
  });

  // SA-517 item 4 (the lead's fold on #2603): the deposit check nets CONFIRMED payments only — the
  // same `payments: { where: CONFIRMED_PAYMENT }` the balance uses. Each case seeds its own invoice
  // (a 50% deposit due 10 days ago on a 1000 invoice due in 30) and reads only its own row.
  const depositInvoice = async (
    suffix: string,
    payment: { amount: number; status: "PAID" | "DRAFT" },
  ) =>
    prisma.invoice.create({
      data: {
        customerId: CUSTOMER,
        tenantId: TENANT,
        status: "SENT",
        invoiceNumber: `INV-${sfx}-${suffix}`,
        subtotal: 1000,
        total: 1000,
        dueDate: dayStamp(30),
        depositPercent: 50,
        depositDueDate: dayStamp(-10),
        payments: {
          create: {
            amount: payment.amount,
            method: "CASH",
            status: payment.status,
            tenantId: TENANT,
          },
        },
      },
    });
  const aging = async () =>
    (await tenantCtx.run(TENANT, () => service.getArAgingInvoices())) as any;
  const rowOf = (result: any, invoiceNumber: string) =>
    result.buckets.current.find((e: any) => e.invoiceNumber === invoiceNumber);

  it("#1529: a CONFIRMED payment at or above the deposit ⇒ NOT overdue, and the row stays out of the summary", async () => {
    const before = (await aging()).depositOverdue;
    await depositInvoice("paid", { amount: 600, status: "PAID" });
    const after = await aging();
    expect(rowOf(after, `INV-${sfx}-paid`)).toMatchObject({
      balance: 400,
      depositAmount: 500,
      depositOverdue: false,
    });
    expect(after.depositOverdue).toEqual(before); // not counted, adds nothing outstanding
  });

  it("#1529: a DRAFT payment is ignored in totalPaid — the deposit stays overdue and the balance whole", async () => {
    const before = (await aging()).depositOverdue;
    await depositInvoice("draft", { amount: 600, status: "DRAFT" });
    const after = await aging();
    expect(rowOf(after, `INV-${sfx}-draft`)).toMatchObject({
      balance: 1000,
      depositAmount: 500,
      depositOverdue: true,
    });
    expect(after.depositOverdue).toEqual({
      count: before.count + 1,
      outstanding: before.outstanding + 500, // the whole deposit: the DRAFT 600 nets nothing
    });
  });
});
