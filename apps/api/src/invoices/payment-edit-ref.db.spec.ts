/**
 * NEED-DB (row 752, SA-843): editing a payment INTO a duplicate, against real Postgres. Run with the invoices +
 * payment-ref family: `npm run local:test:db` or `RUN_DB_SPECS=1` on an `rf_dbspec_*` database.
 *
 *  - R1: a key change while in the set (B moves onto A's reference and amount) is 409 naming A; B is unchanged.
 *  - R2: a VOID row entering the set with A's key is 409.
 *  - R3: a recorded-anyway pair: a notes-only save of B (the exact body web sends) is 200, no 409, no audit row.
 *  - R4: R1 with staff `recordAnyway` is 200 with exactly ONE PAYMENT_REF_RECORDED_ANYWAY row, meta.paymentIds = [B].
 *  - R5: one standalone group's own rows never collide (the $60 row edited to $40 beside its $40 sibling).
 *  - R6: no `reference` key in the body: the STORED reference is the effective one (409).
 *  - R7: two concurrent edits moving two rows onto the same NEW key: exactly one 409, one 200; and an edit waits on
 *        the payment-ref lock of its NEW key.
 *  - SA-865 G1-G3: a GROUPED row is judged on the group's NEW total (its siblings, possibly on other invoices, plus its
 *        excess advance), the way a fresh record of the group is judged.
 *
 * SAFETY: throwaway `qa-r752-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll` deletes what it made.
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
import { _resetLockPoolForTests, withAdvisoryLock } from "../common/db-locks";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-r752-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-edit-ref.db.spec.ts",
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

describeDb("row 752 editing a payment into a duplicate — real Postgres", () => {
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
    await _resetLockPoolForTests(); // the payment-ref lock pool, or jest never exits
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prismaA.auditLog.deleteMany({ where: { tenantId } });
    await prismaA.advancePayment.deleteMany({ where: { tenantId } });
    await prismaA.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await prismaA.invoice.deleteMany({ where: { tenantId } });
    await prismaA.customer.deleteMany({ where: { tenantId } });
    await prismaA.user.deleteMany({ where: { tenantId } });
    await prismaA.tenant.delete({ where: { id: tenantId } });
  }

  /** A tenant, one account customer with three open $1000 invoices, and a staff user. */
  async function seed(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await prismaA.tenant.create({ data: { slug, name: `R752 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const buyer = await prismaA.user.create({
      data: {
        email: `a-${tenant.id}@example.invalid`,
        username: `a-${tenant.id}`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prismaA.customer.create({
      data: {
        userId: buyer.id,
        businessName: "R752 a",
        contactName: "R752 a",
        tenantId: tenant.id,
      },
    });
    const staff = await prismaA.user.create({
      data: {
        email: `staff-${tenant.id}@example.invalid`,
        username: `staff-${tenant.id}`,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const invs: { id: string; invoiceNumber: string }[] = [];
    for (let i = 0; i < 3; i++)
      // eslint-disable-next-line no-await-in-loop
      invs.push(
        await prismaA.invoice.create({
          data: {
            tenantId: tenant.id,
            customerId: customer.id,
            invoiceNumber: `INV-R752-${randomUUID().slice(0, 8)}-${i}`,
            status: "SENT",
            subtotal: 1000,
            total: 1000,
          },
        }),
      );
    const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenant.id, fn);
    /** A stored payment row, written directly (the edit under test is the only path exercised). */
    const row = (
      invoiceId: string,
      over: { amount: number; reference: string; status?: string; paymentGroupId?: string },
    ) =>
      prismaA.invoicePayment.create({
        data: {
          invoiceId,
          tenantId: tenant.id,
          method: "CHECK",
          paidAt: new Date("2026-10-01T12:00:00Z"),
          status: "PAID",
          ...over,
        } as any,
      });
    const get = (id: string) => prismaA.invoicePayment.findUnique({ where: { id } });
    const audits = () =>
      prismaA.auditLog.findMany({
        where: { tenantId: tenant.id, action: "payment.ref-record-anyway" },
      });
    const staffOpts = (recordAnyway: boolean) => ({
      refDedupe: { actor: staff.id, role: "OPERATOR", recordAnyway },
    });
    /** The group's excess advance, booked as writeStandalonePayment books it (same method, reference, paidAt). */
    const advance = (amount: number, reference: string) =>
      prismaA.advancePayment.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          amount,
          balance: amount,
          method: "CHECK",
          reference,
          receivedAt: new Date("2026-10-01T12:00:00Z"),
        },
      });
    return { tenant, customer, staff, invs, asTenant, row, get, audits, staffOpts, advance };
  }

  it("R1 B edited onto A's reference and amount is 409 naming A; B is unchanged", async () => {
    const s = await seed("r1");
    const a = await s.row(s.invs[0].id, { amount: 100, reference: "CHK 100" });
    const b = await s.row(s.invs[1].id, { amount: 50, reference: "X1" });
    const err: any = await s
      .asTenant(() =>
        invoicesA.updatePayment(
          s.invs[1].id,
          b.id,
          { amount: 100, method: "CHECK", reference: "CHK-100" } as any,
          s.staffOpts(false),
        ),
      )
      .catch((e) => e);
    expect(status(err)).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: "DUPLICATE_PAYMENT_REF",
      existingPayment: { id: a.id, invoiceId: s.invs[0].id, amount: 100 },
    });
    const after = await s.get(b.id);
    expect({ ref: after?.reference, amount: Number(after?.amount) }).toEqual({
      ref: "X1",
      amount: 50,
    });
  }, 60_000);

  it("R2 a VOID row entering the set with A's key is 409", async () => {
    const s = await seed("r2");
    await s.row(s.invs[0].id, { amount: 100, reference: "CHK 100" });
    const b = await s.row(s.invs[1].id, { amount: 100, reference: "CHK 100", status: "VOID" });
    const err = await s
      .asTenant(() =>
        invoicesA.updatePayment(
          s.invs[1].id,
          b.id,
          { amount: 100, method: "CHECK", reference: "CHK 100", status: "PAID" } as any,
          s.staffOpts(false),
        ),
      )
      .catch((e) => e);
    expect(status(err)).toBe(409);
    expect((await s.get(b.id))?.status).toBe("VOID");
  }, 60_000);

  it("R3 a notes-only save of a recorded-anyway pair is 200, with no audit row", async () => {
    const s = await seed("r3");
    await s.row(s.invs[0].id, { amount: 100, reference: "CHK 100" });
    const b = await s.row(s.invs[1].id, { amount: 100, reference: "CHK 100" });
    await s.asTenant(() =>
      invoicesA.updatePayment(
        s.invs[1].id,
        b.id,
        { amount: 100, method: "CHECK", reference: "CHK 100", notes: "called the bank" } as any,
        s.staffOpts(false),
      ),
    );
    expect((await s.get(b.id))?.notes).toBe("called the bank");
    expect(await s.audits()).toHaveLength(0);
  }, 60_000);

  it("R4 staff recordAnyway: 200 and exactly one audit row naming the edited payment", async () => {
    const s = await seed("r4");
    const a = await s.row(s.invs[0].id, { amount: 100, reference: "CHK 100" });
    const b = await s.row(s.invs[1].id, { amount: 50, reference: "X1" });
    await s.asTenant(() =>
      invoicesA.updatePayment(
        s.invs[1].id,
        b.id,
        { amount: 100, method: "CHECK", reference: "CHK-100" } as any,
        s.staffOpts(true),
      ),
    );
    expect((await s.get(b.id))?.reference).toBe("CHK-100");
    const rows = await s.audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: s.staff.id, entityId: s.invs[1].id });
    expect(rows[0].meta).toMatchObject({
      paymentIds: [b.id],
      duplicateOfPaymentId: a.id,
      normalisedRef: "CHK100",
    });
  }, 60_000);

  it("R5 one standalone group's own rows never collide", async () => {
    const s = await seed("r5");
    const g = randomUUID();
    const sixty = await s.row(s.invs[0].id, { amount: 60, reference: "R9", paymentGroupId: g });
    await s.row(s.invs[1].id, { amount: 40, reference: "R9", paymentGroupId: g });
    await s.asTenant(() =>
      invoicesA.updatePayment(
        s.invs[0].id,
        sixty.id,
        { amount: 40, method: "CHECK", reference: "R9" } as any,
        s.staffOpts(false),
      ),
    );
    expect(Number((await s.get(sixty.id))?.amount)).toBe(40);
  }, 60_000);

  it("R6 no reference key in the body: the stored reference collides (409)", async () => {
    const s = await seed("r6");
    await s.row(s.invs[0].id, { amount: 100, reference: "CHK 100" });
    const b = await s.row(s.invs[1].id, { amount: 50, reference: "chk-100" });
    const err = await s
      .asTenant(() =>
        invoicesA.updatePayment(
          s.invs[1].id,
          b.id,
          { amount: 100, method: "CHECK" } as any,
          s.staffOpts(false),
        ),
      )
      .catch((e) => e);
    expect(status(err)).toBe(409);
    expect(Number((await s.get(b.id))?.amount)).toBe(50);
  }, 60_000);

  it("R7 two concurrent edits onto the same NEW key on two connections: exactly one 409, one 200", async () => {
    const s = await seed("r7");
    const b1 = await s.row(s.invs[1].id, { amount: 100, reference: "X1" });
    const b2 = await s.row(s.invs[2].id, { amount: 100, reference: "X2" });
    const edit = (svc: InvoicesService, invoiceId: string, id: string) =>
      s
        .asTenant(() =>
          svc.updatePayment(
            invoiceId,
            id,
            { amount: 100, method: "CHECK", reference: "NEW 1" } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
    const results = await Promise.all([
      edit(invoicesA, s.invs[1].id, b1.id),
      edit(invoicesB, s.invs[2].id, b2.id),
    ]);
    expect(results.map(status).sort()).toEqual([409, "ok"]);
    // one row moved onto the new key, the other kept its own
    const refs = [(await s.get(b1.id))?.reference, (await s.get(b2.id))?.reference];
    expect(refs.filter((r) => r === "NEW 1")).toHaveLength(1);
    expect(refs.filter((r) => r === "X1" || r === "X2")).toHaveLength(1);
  }, 60_000);

  it("R7b an edit waits on the payment-ref lock of its NEW key", async () => {
    const s = await seed("r7b");
    const b = await s.row(s.invs[1].id, { amount: 100, reference: "X1" });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = withAdvisoryLock(
      { family: "payment-ref", key: `${s.tenant.id}:CHECK:NEW1`, mode: "wait", waitMs: 10_000 },
      async () => {
        locked();
        await held;
      },
    );
    await isLocked;
    let settled = false;
    const editing = s
      .asTenant(() =>
        invoicesA.updatePayment(
          s.invs[1].id,
          b.id,
          { amount: 100, method: "CHECK", reference: "new-1" } as any,
          s.staffOpts(false),
        ),
      )
      .finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 1500));
    expect(settled).toBe(false); // still waiting on the NEW key's lock
    release();
    await holder;
    await editing;
    expect((await s.get(b.id))?.reference).toBe("new-1");
  }, 60_000);

  describe("SA-865: an edit of a grouped row is judged on the group's NEW total", () => {
    /** G = $60 (invoice 0) + $30 (invoice 1) on "R9"; X = $100 "R9", another attempt, on invoice 2. */
    async function groupAndX(label: string) {
      const s = await seed(label);
      const g = randomUUID();
      await s.row(s.invs[0].id, { amount: 60, reference: "R9", paymentGroupId: g });
      const thirty = await s.row(s.invs[1].id, { amount: 30, reference: "R9", paymentGroupId: g });
      const x = await s.row(s.invs[2].id, { amount: 100, reference: "R9" });
      const edit = (amount: number) =>
        s
          .asTenant(() =>
            invoicesA.updatePayment(
              s.invs[1].id,
              thirty.id,
              { amount, method: "CHECK", reference: "R9" } as any,
              s.staffOpts(false),
            ),
          )
          .catch((e) => e);
      return { s, thirty, x, edit };
    }

    it("G1 $30 -> $40 makes G $100, equal to X: 409 naming X", async () => {
      const { s, thirty, x, edit } = await groupAndX("g1");
      const err: any = await edit(40);
      expect(status(err)).toBe(409);
      expect(err.getResponse()).toMatchObject({ existingPayment: { id: x.id } });
      expect(Number((await s.get(thirty.id))?.amount)).toBe(30);
    }, 60_000);

    it("G2 $30 -> $35 makes G $95: 200", async () => {
      const { s, thirty, edit } = await groupAndX("g2");
      expect(status(await edit(35))).toBe("ok");
      expect(Number((await s.get(thirty.id))?.amount)).toBe(35);
    }, 60_000);

    it("G3 with a $10 excess advance: an unchanged amount runs no check; $30 -> $31 (G + advance $101) is 200", async () => {
      const { s, thirty, edit } = await groupAndX("g3");
      await s.advance(10, "R9"); // G + advance = $100 already, equal to X: only a CHANGED key may be judged
      expect(status(await edit(30))).toBe("ok");
      expect(status(await edit(31))).toBe("ok");
      expect(Number((await s.get(thirty.id))?.amount)).toBe(31);
    }, 60_000);
  });
});
