/**
 * NEED-DB (row 498, SA-837 + lead rulings 2026-10-22): the payment-reference dedupe against real Postgres.
 * NOT RUN by the author (no DB lane in the builder session): run with the invoices/payments family,
 * `npm run local:test:db` or `RUN_DB_SPECS=1` on an `rf_dbspec_*` database.
 *
 *  - D1: the same reference, amount, customer and method a DAY later is 409 DUPLICATE_PAYMENT_REF naming the first
 *        payment (no time window); another customer with the same reference records.
 *  - D2: two connections, two NEW attempts (different Idempotency-Keys), the same reference, concurrently: exactly
 *        ONE payment is recorded, the other is 409. The loser waits on the `payment-ref` advisory lock.
 *  - D3: LOCK ORDER on real locks: a path that holds the customer merge lock ("order-merge") and then records a
 *        payment, racing a plain recorder of the same reference, finishes without a deadlock; one records, one 409.
 *  - D4: the shared walk-in identity is never deduped (two records both save).
 *  - D5: staff `recordAnyway` saves the repeat with exactly ONE audit row (actor, invoice, normalised reference,
 *        the duplicated payment id); a non-staff role's flag is ignored (409).
 *  - D6: sibling payments of ONE attempt (a shared `paymentAttempt`) both record; the next attempt is refused.
 *  - D7: a replay of the same Idempotency-Key replays the stored result and is never refused as a duplicate.
 *
 * SAFETY: throwaway `qa-r498-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll` deletes what it made.
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
import { withAdvisoryLock } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-r498-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-ref-dedupe.db.spec.ts",
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

describeDb("row 498 payment reference dedupe — real Postgres", () => {
  let tenantCtx: TenantContextService;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let invoicesA: InvoicesService;
  let invoicesB: InvoicesService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prismaA = new PrismaService(tenantCtx);
    prismaB = new PrismaService(tenantCtx);
    await prismaA.$connect();
    await prismaB.$connect();
    invoicesA = await buildInvoices(prismaA, tenantCtx);
    invoicesB = await buildInvoices(prismaB, tenantCtx);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => undefined);
    }
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prismaA.auditLog.deleteMany({ where: { tenantId } });
    await prismaA.paymentIdempotencyKey.deleteMany({ where: { tenantId } });
    await prismaA.advancePayment.deleteMany({ where: { tenantId } });
    await prismaA.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prismaA.invoice.deleteMany({ where: { tenantId } });
    await prismaA.paymentCounter.deleteMany({ where: { id: tenantId } });
    await prismaA.customer.deleteMany({ where: { tenantId } });
    await prismaA.user.deleteMany({ where: { tenantId } });
    await prismaA.tenant.delete({ where: { id: tenantId } });
  }

  /** A tenant with `n` open $1000 invoices for one account customer, and a second customer's invoice. */
  async function seed(label: string, opts: { walkIn?: boolean; invoices?: number } = {}) {
    const slug = freshTenantSlug(label);
    const tenant = await prismaA.tenant.create({ data: { slug, name: `R498 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const makeCustomer = async (tag: string, walkIn = false) => {
      const user = await prismaA.user.create({
        data: {
          email: `${tag}-${tenant.id}@example.invalid`,
          username: `${tag}-${tenant.id}`,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      return prismaA.customer.create({
        data: {
          userId: user.id,
          businessName: `R498 ${tag}`,
          contactName: `R498 ${tag}`,
          tenantId: tenant.id,
          isWalkIn: walkIn,
        },
      });
    };
    const staff = await prismaA.user.create({
      data: {
        email: `staff-${tenant.id}@example.invalid`,
        username: `staff-${tenant.id}`,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const customer = await makeCustomer("a", opts.walkIn === true);
    const other = await makeCustomer("b");
    const makeInvoice = (customerId: string, n: number) =>
      prismaA.invoice.create({
        data: {
          tenantId: tenant.id,
          customerId,
          invoiceNumber: `INV-R498-${randomUUID().slice(0, 8)}-${n}`,
          status: "SENT",
          subtotal: 1000,
          total: 1000,
        },
      });
    const invs: Awaited<ReturnType<typeof makeInvoice>>[] = [];
    for (let i = 0; i < (opts.invoices ?? 3); i++) invs.push(await makeInvoice(customer.id, i));
    const otherInvoice = await makeInvoice(other.id, 99);
    const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenant.id, fn);
    const pay = (over: Record<string, unknown> = {}) =>
      ({
        amount: 100,
        method: "CHECK",
        reference: "CHK-7788",
        paidAt: "2026-10-01",
        ...over,
      }) as any;
    const payments = () =>
      prismaA.invoicePayment.findMany({ where: { invoice: { tenantId: tenant.id } } });
    const audits = () =>
      prismaA.auditLog.findMany({
        where: { tenantId: tenant.id, action: "payment.ref-record-anyway" },
      });
    return { tenant, staff, customer, invs, otherInvoice, asTenant, pay, payments, audits };
  }

  it("D1 the same reference, amount, customer and method a DAY later is 409 naming the first payment; another customer records", async () => {
    const s = await seed("d1");
    const first: any = await s.asTenant(() =>
      invoicesA.recordPayment(s.invs[0].id, s.pay({ paidAt: "2026-10-01" })),
    );
    const err: any = await s
      .asTenant(() => invoicesA.recordPayment(s.invs[1].id, s.pay({ paidAt: "2026-10-02" })))
      .catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: "DUPLICATE_PAYMENT_REF",
      existingPayment: {
        id: first.createdPaymentId,
        amount: 100,
        invoiceId: s.invs[0].id,
        invoiceNumber: s.invs[0].invoiceNumber,
      },
    });
    await s.asTenant(() => invoicesA.recordPayment(s.otherInvoice.id, s.pay()));
    expect(await s.payments()).toHaveLength(2);
  }, 60_000);

  it("D2 two connections, two NEW attempts with the same reference, concurrently: exactly one is recorded, the other is 409", async () => {
    const s = await seed("d2");
    let winnerInTx!: () => void;
    const winnerHolds = new Promise<void>((r) => (winnerInTx = r));
    const winner = s.asTenant(() =>
      invoicesA.recordPayment(s.invs[0].id, s.pay(), {
        idempotencyKey: `race-a-${randomUUID()}`,
        inTx: async () => {
          winnerInTx();
          await new Promise((r) => setTimeout(r, 800)); // hold the transaction (and the payment-ref lock) open
        },
      } as any),
    );
    await winnerHolds;
    const loser = s
      .asTenant(() =>
        invoicesB.recordPayment(s.invs[1].id, s.pay(), {
          idempotencyKey: `race-b-${randomUUID()}`,
        }),
      )
      .catch((e) => e);
    const [w, l]: any[] = await Promise.all([winner, loser]);
    expect(w.createdPaymentId).toBeTruthy();
    expect(l.getStatus()).toBe(409);
    expect(l.getResponse()).toMatchObject({ code: "DUPLICATE_PAYMENT_REF" });
    expect(await s.payments()).toHaveLength(1);
  }, 60_000);

  it("D3 lock order: merge lock then payment-ref (one path) races a plain recorder of the same reference: no deadlock, one recorded, one 409", async () => {
    const s = await seed("d3");
    const viaMerge = withAdvisoryLock(
      { family: "order-merge", key: s.customer.id, mode: "wait", waitMs: 10_000 },
      () => s.asTenant(() => invoicesA.recordPayment(s.invs[0].id, s.pay())),
    ).catch((e) => e);
    const plain = s.asTenant(() => invoicesB.recordPayment(s.invs[1].id, s.pay())).catch((e) => e);
    const [a, b]: any[] = await Promise.all([viaMerge, plain]);
    const outcomes = [a?.value ?? a, b].map((x: any) => (x?.getStatus?.() === 409 ? 409 : "ok"));
    expect(outcomes.sort()).toEqual([409, "ok"]);
    expect(await s.payments()).toHaveLength(1);
  }, 60_000);

  it("D4 the shared walk-in identity is never deduped", async () => {
    const s = await seed("d4", { walkIn: true });
    await s.asTenant(() => invoicesA.recordPayment(s.invs[0].id, s.pay({ method: "CREDIT_CARD" })));
    await s.asTenant(() => invoicesA.recordPayment(s.invs[1].id, s.pay({ method: "CREDIT_CARD" })));
    expect(await s.payments()).toHaveLength(2);
  }, 60_000);

  it("D5 staff recordAnyway saves the repeat with exactly one audit row; a non-staff flag is ignored", async () => {
    const s = await seed("d5");
    const first: any = await s.asTenant(() => invoicesA.recordPayment(s.invs[0].id, s.pay()));
    const refused: any = await s
      .asTenant(() =>
        invoicesA.recordPayment(s.invs[1].id, s.pay(), {
          refDedupe: { actor: "u-9", role: "CUSTOMER", recordAnyway: true },
        }),
      )
      .catch((e) => e);
    expect(refused.getStatus()).toBe(409);
    expect(await s.audits()).toHaveLength(0);

    await s.asTenant(() =>
      invoicesA.recordPayment(s.invs[1].id, s.pay(), {
        refDedupe: { actor: s.staff.id, role: "OPERATOR", recordAnyway: true },
      }),
    );
    expect(await s.payments()).toHaveLength(2);
    const rows = await s.audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: s.staff.id,
      entityType: "invoice",
      entityId: s.invs[1].id,
    });
    expect(rows[0].meta).toMatchObject({
      actor: s.staff.id,
      invoiceId: s.invs[1].id,
      normalisedRef: "CHK7788",
      duplicateOfPaymentId: first.createdPaymentId,
    });
  }, 60_000);

  it("D6 sibling payments of ONE attempt both record; the next separate attempt is refused", async () => {
    const s = await seed("d6");
    const attempt = { ids: new Set<string>() };
    await s.asTenant(() =>
      invoicesA.recordPayment(s.invs[0].id, s.pay(), { paymentAttempt: attempt } as any),
    );
    await s.asTenant(() =>
      invoicesA.recordPayment(s.invs[1].id, s.pay(), { paymentAttempt: attempt } as any),
    );
    expect(await s.payments()).toHaveLength(2);
    const err: any = await s
      .asTenant(() => invoicesA.recordPayment(s.invs[2].id, s.pay()))
      .catch((e) => e);
    expect(err.getStatus()).toBe(409);
  }, 60_000);

  it("D7 a replay of the same Idempotency-Key replays and is never refused as a duplicate reference", async () => {
    const s = await seed("d7");
    const key = `replay-${randomUUID()}`;
    const first: any = await s.asTenant(() =>
      invoicesA.recordPayment(s.invs[0].id, s.pay(), { idempotencyKey: key }),
    );
    const again: any = await s.asTenant(() =>
      invoicesB.recordPayment(s.invs[0].id, s.pay(), { idempotencyKey: key }),
    );
    expect(again.replayed).toBe(true);
    expect(again.createdPaymentId).toBe(first.createdPaymentId);
    expect(await s.payments()).toHaveLength(1);
  }, 60_000);

  it("D8 a Stripe-captured payment that repeats an existing normalised reference + amount is recorded, never 409, and flagged once", async () => {
    const s = await seed("d8");
    const manual = (ref: string) => ({
      customerId: s.customer.id,
      totalAmount: 100,
      method: "CREDIT_CARD",
      reference: ref,
      paidAt: "2026-10-01",
      allocations: [{ invoiceId: s.invs[0].id, amount: 100 }],
    });
    await s.asTenant(() =>
      invoicesA.recordStandalonePayment(manual(" PI_3ABC ") as any, {} as any),
    );
    const capture = { source: "STRIPE" as const, sourceRef: "pi_3Abc", suspects: [] as any[] };
    const res: any = await s.asTenant(() =>
      invoicesB.recordStandalonePayment(
        { ...manual("pi_3Abc"), allocations: [{ invoiceId: s.invs[1].id, amount: 100 }] } as any,
        { capturedExternally: capture } as any,
      ),
    );
    expect(res.paymentGroupId).toBeTruthy();
    expect(await s.payments()).toHaveLength(2);
    const audits = await prismaA.auditLog.findMany({
      where: { tenantId: s.tenant.id, action: "payment.ref-duplicate-suspect" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ source: "STRIPE", paymentIntentId: "pi_3Abc" });
    expect(capture.suspects).toHaveLength(1);
  }, 60_000);

  it("D9 the same payment intent offered twice records once: a PaymentAlreadyRecordedError names the first group", async () => {
    const s = await seed("d9");
    const dto = {
      customerId: s.customer.id,
      totalAmount: 100,
      method: "CREDIT_CARD",
      reference: "pi_same",
      allocations: [{ invoiceId: s.invs[0].id, amount: 100 }],
    } as any;
    const cap = () =>
      ({ capturedExternally: { source: "STRIPE", sourceRef: "pi_same", suspects: [] } }) as any;
    const first: any = await s.asTenant(() => invoicesA.recordStandalonePayment(dto, cap()));
    const err: any = await s
      .asTenant(() => invoicesB.recordStandalonePayment(dto, cap()))
      .catch((e) => e);
    expect(err.name).toBe("PaymentAlreadyRecordedError");
    expect(err.paymentGroupId).toBe(first.paymentGroupId);
    expect(await s.payments()).toHaveLength(1);
  }, 60_000);
});
