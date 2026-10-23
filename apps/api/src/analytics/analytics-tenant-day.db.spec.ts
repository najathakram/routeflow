/**
 * DB-lane spec for SA-906 / W-728 against a REAL Postgres: credits, external refunds and write-offs are real-instant columns, so
 * the accrual readers window them on the TENANT's own days. Chicago is west of UTC (the evening of Oct 31 is already Nov 1 in UTC),
 * and the null zone is today's UTC behaviour. Collected by `jest.db.config.js`, run via `npm run local:test:db`.
 * Own qa- tenant, cleaned up after.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  fetchAccrualNetSales,
  fetchAccrualNetSalesByCustomer,
  fetchAccrualNetSalesByCustomerRows,
  fetchBadDebtExpense,
} from "../common/invoiced-sales";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const CHICAGO = "America/Chicago";
const OCT = {
  gte: new Date("2026-10-01T00:00:00.000Z"),
  lte: new Date("2026-10-31T23:59:59.999Z"),
};
const NOV = {
  gte: new Date("2026-11-01T00:00:00.000Z"),
  lte: new Date("2026-11-30T23:59:59.999Z"),
};
const LATE_OCT_31 = new Date("2026-11-01T04:30:00.000Z"); // 23:30 CDT on Oct 31
const LATE_SEP_30 = new Date("2026-10-01T03:00:00.000Z"); // 22:00 CDT on Sep 30

describeDb("accrual readers on the tenant's own day, real Postgres (SA-906)", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let tenantId = "";
  let customerId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const slug = assertTestTenant(`qa-tday-${RUN}`, "analytics-tenant-day.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `tday ${slug}` } })).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "tday", contactName: "tday", tenantId } as any,
      })
    ).id;
    const credit = (n: number, amount: number, createdAt: Date) =>
      prisma.creditNote.create({
        data: {
          tenantId,
          customerId,
          invoiceId: null,
          creditNoteNumber: `CN-TDAY-${RUN}-${n}`,
          status: "ISSUED",
          amount,
          createdAt,
        } as any,
      });
    await credit(1, 10, LATE_OCT_31);
    await credit(2, 7, LATE_SEP_30);
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId,
        orderNumber: `ORD-TDAY-${RUN}`,
        subtotal: 3,
        tax: 0,
        total: 3,
        status: "DELIVERED",
      } as any,
    });
    await prisma.return.create({
      data: {
        tenantId,
        customerId,
        orderId: order.id,
        returnNumber: `RET-TDAY-${RUN}`,
        reason: "DAMAGED",
        status: "REFUNDED",
        kind: "INLINE",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 3,
        refundedAt: LATE_OCT_31,
      } as any,
    });
    await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        invoiceNumber: `INV-TDAY-${RUN}`,
        status: "WRITTEN_OFF",
        issueDate: new Date("2026-08-05T00:00:00.000Z"),
        writtenOffAt: LATE_OCT_31,
        subtotal: 40,
        taxAmount: 0,
        total: 40,
      } as any,
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    await prisma.return.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.creditNote.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.invoice.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.order.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await prisma.$disconnect();
    await pool.end().catch(swallow);
  });

  const net = (w: typeof OCT, timeZone?: string | null) =>
    fetchAccrualNetSales(prisma as any, tenantId, w, { timeZone }).then((r) => r.net);

  it("R1/R4: the 23:30 Chicago credit and refund on Oct 31 are OCTOBER's; the 22:00 Sep 30 credit is not", async () => {
    expect(await net(OCT, CHICAGO)).toBe(-13);
  });

  it("R2: the same events are NOT November's for a Chicago tenant", async () => {
    expect(await net(NOV, CHICAGO)).toBe(0);
  });

  it("R9: a null zone keeps today's UTC windows (Oct = the Oct 1 03:00Z credit; Nov = the Nov 1 04:30Z pair)", async () => {
    expect(await net(OCT, null)).toBe(-7);
    expect(await net(NOV, null)).toBe(-13);
  });

  it("R8: the by-customer reader agrees with the total", async () => {
    const by = await fetchAccrualNetSalesByCustomer(prisma as any, tenantId, OCT, {
      timeZone: CHICAGO,
    });
    expect(by.get(customerId)?.net).toBe(-13);
  });

  it("R11 parity: with the tenant's zone the total reader (P&L) equals the row reader (dashboard), both months", async () => {
    for (const w of [OCT, NOV]) {
      const total = await net(w, CHICAGO);
      const rows = await fetchAccrualNetSalesByCustomerRows(prisma as any, tenantId, w, {
        timeZone: CHICAGO,
      });
      const rowSum = [...rows.values()].reduce((a, r) => a + r.net, 0);
      expect(Math.round(rowSum * 100) / 100).toBe(total);
    }
  });

  it("R10: a write-off at 23:30 local on Oct 31 is OCTOBER's bad debt for Chicago, November's for UTC", async () => {
    const chicagoOct = await fetchBadDebtExpense(prisma as any, tenantId, OCT, {
      timeZone: CHICAGO,
    });
    const chicagoNov = await fetchBadDebtExpense(prisma as any, tenantId, NOV, {
      timeZone: CHICAGO,
    });
    const utcOct = await fetchBadDebtExpense(prisma as any, tenantId, OCT, { timeZone: null });
    const utcNov = await fetchBadDebtExpense(prisma as any, tenantId, NOV, { timeZone: null });
    expect(chicagoOct).toBeGreaterThan(0);
    expect(chicagoNov).toBe(0);
    expect(utcOct).toBe(0);
    expect(utcNov).toBe(chicagoOct);
  });
});
