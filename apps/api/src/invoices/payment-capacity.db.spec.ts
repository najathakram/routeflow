/**
 * NEED-DB (row 2299, SA-858): payment CAPACITY against real Postgres. CAPACITY = every non-VOID row (DRAFT + PAID +
 * PENDING). Run with the invoices + bookkeeping + payment-requests DB lanes (`npm run local:test:db`).
 *
 *  - R1: recordPayment DRAFT on an invoice whose PAID rows cover the total is 400 FULLY_PAID, nothing written.
 *  - R2: recordPayment DRAFT above the remaining capacity is 400 EXCEEDS.
 *  W-769 (owner 7b = A, SA-910 Part 2 / SA-922): W1-W12 (real money over a DRAFT), U1-U2 (unconfirmed still fits), C1-C4 (the
 *  confirm and the read side). The till (W2/W3), bookkeeping, delivery, buyer and captured writers and the races are in
 *  their own homes.
 *
 * SAFETY: throwaway `qa-r2299-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll` deletes what it made.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { _resetLockPoolForTests } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-r2299-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-capacity.db.spec.ts",
  );
}

/** One InvoicesService on its OWN PrismaService (its own pool = its own connections). */
async function buildInvoices(prisma: PrismaService, tenantCtx: TenantContextService) {
  const module = await Test.createTestingModule({
    providers: [
      InvoicesService,
      NumberingService,
      {
        provide: SellingRestrictionsService,
        useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: TenantContextService, useValue: tenantCtx },
      { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
      { provide: EmailService, useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      {
        provide: SystemConfigService,
        useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
      },
      {
        provide: RegulatedLedgerService,
        useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
      },
      {
        provide: AuthorizationGuardService,
        useValue: {
          assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
          checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
        },
      },
      {
        provide: CreditNotesService,
        useValue: {
          autoApplyOldestCreditsInTx: jest
            .fn()
            .mockResolvedValue({ applied: 0, invoiceStatus: null }),
          releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: MessagingService,
        useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
      },
      { provide: StorageService, useValue: {} },
      { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
      {
        provide: CommissionEngineService,
        useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return module.get(InvoicesService);
}

const status = (e: any) => (typeof e?.getStatus === "function" ? e.getStatus() : "ok");

describeDb("row 2299 payment capacity — real Postgres", () => {
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  let invoices: InvoicesService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    invoices = await buildInvoices(prisma, tenantCtx);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prisma?.$disconnect();
    await _resetLockPoolForTests(); // the payment-ref lock pool, or jest never exits
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.paymentIdempotencyKey.deleteMany({ where: { tenantId } });
    await prisma.advancePayment.deleteMany({ where: { tenantId } });
    await prisma.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.paymentCounter.deleteMany({ where: { id: tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** A tenant, one account customer with two open $100 invoices. */
  async function seed(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `R2299 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const buyer = await prisma.user.create({
      data: {
        email: `a-${tenant.id}@example.invalid`,
        username: `a-${tenant.id}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: buyer.id,
        businessName: "R2299 a",
        contactName: "R2299 a",
        tenantId: tenant.id,
      },
    });
    const invs: { id: string; invoiceNumber: string }[] = [];
    for (let i = 0; i < 2; i++)
      // eslint-disable-next-line no-await-in-loop
      invs.push(
        await prisma.invoice.create({
          data: {
            tenantId: tenant.id,
            customerId: customer.id,
            invoiceNumber: `INV-R2299-${randomUUID().slice(0, 8)}-${i}`,
            status: "SENT",
            subtotal: 100,
            total: 100,
          },
        }),
      );
    const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenant.id, fn);
    const row = (invoiceId: string, amount: number, status: string) =>
      prisma.invoicePayment.create({
        data: {
          invoiceId,
          tenantId: tenant.id,
          amount,
          method: "CASH",
          status,
          paidAt: new Date("2026-10-01T12:00:00Z"),
        } as any,
      });
    const count = (invoiceId: string) => prisma.invoicePayment.count({ where: { invoiceId } });
    return { tenant, customer, invs, asTenant, row, count };
  }

  it("R1 a DRAFT recorded on an invoice already fully PAID is 400 FULLY_PAID; nothing written", async () => {
    const s = await seed("r1");
    await s.row(s.invs[0].id, 100, "PAID");
    const err = await s
      .asTenant(() =>
        invoices.recordPayment(s.invs[0].id, {
          amount: 10,
          method: "CASH",
          status: "DRAFT",
          paidAt: "2026-10-02",
        } as any),
      )
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(err.message).toBe("Invoice is already fully paid");
    expect(await s.count(s.invs[0].id)).toBe(1);
  }, 60_000);

  it("R2 a DRAFT above the remaining capacity (total 100, PAID 60, DRAFT 50) is 400 EXCEEDS", async () => {
    const s = await seed("r2");
    await s.row(s.invs[0].id, 60, "PAID");
    const err = await s
      .asTenant(() =>
        invoices.recordPayment(s.invs[0].id, {
          amount: 50,
          method: "CASH",
          status: "DRAFT",
          paidAt: "2026-10-02",
        } as any),
      )
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(err.message).toMatch(/^Payment exceeds remaining balance of /);
    expect(await s.count(s.invs[0].id)).toBe(1);
  }, 60_000);

  // ── W-769 (owner 7b = A, SA-910 Part 2 as SA-922 corrects it): real money is never turned away by an unconfirmed row ──
  // Fixture: invoice total 100, SENT, one DRAFT 100 ("D"). Every assertion reads the DB.
  const OVER_RESERVED = "payment.unconfirmed-over-reserved"; // SA-862's PAYMENT_UNCONFIRMED_OVER_RESERVED audit row
  const rowsOf = (invoiceId: string) =>
    prisma.invoicePayment.findMany({
      where: { invoiceId },
      orderBy: { createdAt: "asc" },
      select: { id: true, amount: true, status: true },
    });
  const shape = async (invoiceId: string) =>
    (await rowsOf(invoiceId)).map((r) => `${r.status} ${Number(r.amount)}`);
  const invoiceStatus = async (invoiceId: string) =>
    (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status;
  const overReserved = (tenantId: string) =>
    prisma.auditLog.findMany({ where: { tenantId, action: OVER_RESERVED } });
  const cash = (amount: number, extra: object = {}) =>
    ({ amount, method: "CASH", paidAt: "2026-10-02", ...extra }) as any;
  const standalone = (customerId: string, invoiceId: string, amount: number, extra: object = {}) =>
    ({
      customerId,
      totalAmount: amount,
      method: "CASH",
      paidAt: "2026-10-02",
      allocations: [{ invoiceId, amount: Math.min(amount, 100) }],
      ...extra,
    }) as any;

  it("W1 recordPayment (the invoice page) PAID 100 over a DRAFT 100: recorded, invoice PAID, D stays DRAFT and is flagged once", async () => {
    const s = await seed("w769-w1");
    const d = await s.row(s.invs[0].id, 100, "DRAFT");
    await s.asTenant(() => invoices.recordPayment(s.invs[0].id, cash(100)));
    expect(await shape(s.invs[0].id)).toEqual(["DRAFT 100", "PAID 100"]);
    expect(await invoiceStatus(s.invs[0].id)).toBe("PAID");
    const rows = await overReserved(s.tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ invoiceId: s.invs[0].id, displaced: [d.id] });
  }, 60_000);

  it("W4 the office standalone PAID 100 over a DRAFT 100: recorded and D flagged (master: recorded with no audit row)", async () => {
    const s = await seed("w769-w4");
    const d = await s.row(s.invs[0].id, 100, "DRAFT");
    await s.asTenant(() =>
      invoices.recordStandalonePayment(standalone(s.customer.id, s.invs[0].id, 100)),
    );
    expect(await shape(s.invs[0].id)).toEqual(["DRAFT 100", "PAID 100"]);
    const rows = await overReserved(s.tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ displaced: [d.id] });
  }, 60_000);

  it("W5 bookkeeping (REG-B11) PAID 100 over a DRAFT 100: recorded and D flagged once (master: recorded, no audit row)", async () => {
    const s = await seed("w769-w5");
    const d = await s.row(s.invs[0].id, 100, "DRAFT");
    const unused = {} as never;
    const commissions = { syncInvoiceCommissionSafe: async () => undefined } as never;
    const ledger = new BookkeepingService(
      prisma,
      unused,
      unused,
      unused,
      unused,
      unused,
      commissions,
    );
    await s.asTenant(() => ledger.recordPayment(s.invs[0].id, cash(100)));
    expect(await shape(s.invs[0].id)).toEqual(["DRAFT 100", "PAID 100"]);
    const rows = await overReserved(s.tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toMatchObject({ displaced: [d.id] });
  }, 60_000);

  it("W9 partial: PAID 60 + DRAFT 40, recordPayment 40 records, invoice PAID, D flagged (master: 400, capacity 0)", async () => {
    const s = await seed("w769-w9");
    await s.row(s.invs[0].id, 60, "PAID");
    const d = await s.row(s.invs[0].id, 40, "DRAFT");
    await s.asTenant(() => invoices.recordPayment(s.invs[0].id, cash(40)));
    expect(await shape(s.invs[0].id)).toEqual(["PAID 60", "DRAFT 40", "PAID 40"]);
    expect(await invoiceStatus(s.invs[0].id)).toBe("PAID");
    expect((await overReserved(s.tenant.id))[0]?.meta).toMatchObject({ displaced: [d.id] });
  }, 60_000);

  const paidAtOf = async (invoiceId: string) =>
    (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).paidAt;

  it("W9b voiding the flagged DRAFT (voidPayment): the invoice stays PAID and keeps its paidAt", async () => {
    const s = await seed("w769-w9b");
    await s.row(s.invs[0].id, 60, "PAID");
    const d = await s.row(s.invs[0].id, 40, "DRAFT");
    await s.asTenant(() => invoices.recordPayment(s.invs[0].id, cash(40)));
    const stamped = await paidAtOf(s.invs[0].id);
    expect(stamped).not.toBeNull();
    await s.asTenant(() => invoices.voidPayment(s.invs[0].id, d.id));
    expect(await shape(s.invs[0].id)).toEqual(["PAID 60", "VOID 40", "PAID 40"]);
    expect(await invoiceStatus(s.invs[0].id)).toBe("PAID");
    expect(await paidAtOf(s.invs[0].id)).toEqual(stamped);
  }, 60_000);

  it("W9c voiding the flagged DRAFT (updatePayment to VOID): the invoice stays PAID, paidAt is not re-stamped", async () => {
    const s = await seed("w769-w9c");
    await s.row(s.invs[0].id, 60, "PAID");
    const d = await s.row(s.invs[0].id, 40, "DRAFT");
    await s.asTenant(() => invoices.recordPayment(s.invs[0].id, cash(40)));
    const stamped = await paidAtOf(s.invs[0].id);
    expect(stamped).not.toBeNull();
    await new Promise((r) => setTimeout(r, 25));
    await s.asTenant(() =>
      invoices.updatePayment(s.invs[0].id, d.id, cash(40, { status: "VOID" })),
    );
    expect(await shape(s.invs[0].id)).toEqual(["PAID 60", "VOID 40", "PAID 40"]);
    expect(await invoiceStatus(s.invs[0].id)).toBe("PAID");
    expect(await paidAtOf(s.invs[0].id)).toEqual(stamped);
  }, 60_000);

  it("W10 [L-O2] standalone 150 over a DRAFT 100: PAID 100 on the invoice, 50 to advance, the deliberate-overpay AND over-reserved rows", async () => {
    const s = await seed("w769-w10");
    await s.row(s.invs[0].id, 100, "DRAFT");
    await s.asTenant(() =>
      invoices.recordStandalonePayment(standalone(s.customer.id, s.invs[0].id, 150)),
    );
    expect(await shape(s.invs[0].id)).toEqual(["DRAFT 100", "PAID 100"]);
    const advance = await prisma.advancePayment.findMany({ where: { tenantId: s.tenant.id } });
    expect(advance.map((a) => Number(a.amount))).toEqual([50]);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: s.tenant.id, action: "invoice.deliberate-overpayment" },
      }),
    ).toBe(1);
    expect(await overReserved(s.tenant.id)).toHaveLength(1);
  }, 60_000);

  it("W11 [L-O2] with no unconfirmed rows is unchanged: no over-reserved row (a guard, green on master)", async () => {
    const s = await seed("w769-w11");
    await s.asTenant(() =>
      invoices.recordStandalonePayment(standalone(s.customer.id, s.invs[0].id, 150)),
    );
    expect(await shape(s.invs[0].id)).toEqual(["PAID 100"]);
    expect(await overReserved(s.tenant.id)).toHaveLength(0);
  }, 60_000);

  it("W12 real money that still fits (DRAFT 30, PAID 50): recorded, NO audit row, nothing flagged (no over-flagging)", async () => {
    const s = await seed("w769-w12");
    await s.row(s.invs[0].id, 30, "DRAFT");
    await s.asTenant(() => invoices.recordPayment(s.invs[0].id, cash(50)));
    expect(await shape(s.invs[0].id)).toEqual(["DRAFT 30", "PAID 50"]);
    expect(await overReserved(s.tenant.id)).toHaveLength(0);
  }, 60_000);

  it("U1 recordPayment DRAFT 1 over a DRAFT 100 stays 400 RESERVED_BY_UNCONFIRMED (#3645 kept; green on master)", async () => {
    const s = await seed("w769-u1");
    await s.row(s.invs[0].id, 100, "DRAFT");
    const err = await s
      .asTenant(() => invoices.recordPayment(s.invs[0].id, cash(1, { status: "DRAFT" })))
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(err.message).toBe(
      "Invoice's remaining balance is already reserved by unconfirmed payments",
    );
    expect(await s.count(s.invs[0].id)).toBe(1);
  }, 60_000);

  it("U2 the office standalone DRAFT 1 over a DRAFT 100 is refused (SA-922 answer 1; master: written)", async () => {
    const s = await seed("w769-u2");
    await s.row(s.invs[0].id, 100, "DRAFT");
    const err = await s
      .asTenant(() =>
        invoices.recordStandalonePayment(
          standalone(s.customer.id, s.invs[0].id, 1, { status: "DRAFT" }),
        ),
      )
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(await s.count(s.invs[0].id)).toBe(1);
  }, 60_000);

  it("C1 confirming D once real money covers the total: 409 UNCONFIRMED_PAYMENT_SUPERSEDED, D stays DRAFT (master: 400 exceeds)", async () => {
    const s = await seed("w769-c1");
    const d = await s.row(s.invs[0].id, 100, "DRAFT");
    await s.row(s.invs[0].id, 100, "PAID");
    const err = await s
      .asTenant(() => invoices.updatePayment(s.invs[0].id, d.id, cash(100, { status: "PAID" })))
      .catch((e) => e);
    expect(status(err)).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "UNCONFIRMED_PAYMENT_SUPERSEDED" });
    expect(await shape(s.invs[0].id)).toEqual(["DRAFT 100", "PAID 100"]);
  }, 60_000);

  it("C2 confirming D (50) with PAID 70 stored: the EXCEEDS copy with remaining 30, D stays DRAFT", async () => {
    const s = await seed("w769-c2");
    await s.row(s.invs[0].id, 70, "PAID");
    const d = await s.row(s.invs[0].id, 50, "DRAFT");
    const err = await s
      .asTenant(() => invoices.updatePayment(s.invs[0].id, d.id, cash(50, { status: "PAID" })))
      .catch((e) => e);
    expect(status(err)).toBe(400);
    expect(err.message).toBe("Payment exceeds remaining balance of 30.00");
    expect(await shape(s.invs[0].id)).toEqual(["PAID 70", "DRAFT 50"]);
  }, 60_000);

  it("C2b reopening a VOID 50 to PAID with PAID 100 stored: 409 UNCONFIRMED_PAYMENT_SUPERSEDED (SA-922 answer 2)", async () => {
    const s = await seed("w769-c2b");
    await s.row(s.invs[0].id, 100, "PAID");
    const v = await s.row(s.invs[0].id, 50, "VOID");
    const err = await s
      .asTenant(() => invoices.updatePayment(s.invs[0].id, v.id, cash(50, { status: "PAID" })))
      .catch((e) => e);
    expect(status(err)).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "UNCONFIRMED_PAYMENT_SUPERSEDED" });
    expect(await shape(s.invs[0].id)).toEqual(["PAID 100", "VOID 50"]);
  }, 60_000);

  it("C3 confirming D with no real money stored: PAID, invoice PAID (the unchanged path; green on master)", async () => {
    const s = await seed("w769-c3");
    const d = await s.row(s.invs[0].id, 100, "DRAFT");
    await s.asTenant(() =>
      invoices.updatePayment(s.invs[0].id, d.id, cash(100, { status: "PAID" })),
    );
    expect(await shape(s.invs[0].id)).toEqual(["PAID 100"]);
    expect(await invoiceStatus(s.invs[0].id)).toBe("PAID");
  }, 60_000);

  it("C4 the read side: after W1 the invoice's D carries noLongerFits true; a DRAFT that still fits carries false", async () => {
    const s = await seed("w769-c4");
    const d = await s.row(s.invs[0].id, 100, "DRAFT");
    await s.asTenant(() => invoices.recordPayment(s.invs[0].id, cash(100)));
    const fits = await s.row(s.invs[1].id, 30, "DRAFT");
    const inv: any = await s.asTenant(() => invoices.findOne(s.invs[0].id));
    expect(inv.payments.find((p: any) => p.id === d.id)?.noLongerFits).toBe(true);
    const other: any = await s.asTenant(() => invoices.findOne(s.invs[1].id));
    expect(other.payments.find((p: any) => p.id === fits.id)?.noLongerFits).toBe(false);
  }, 60_000);
});
