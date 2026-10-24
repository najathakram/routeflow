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
 *  - W-719 / SA-879 R1-R4, R6: a group's OWN excess advance is found through its link (`sourcePaymentId`, the group's
 *        first row), or for a legacy unlinked one by any row's paidAt, never by the EDITED row's date alone: no false
 *        409 after a paidAt edit, the group total counts it, on the edit path and the fresh path, and across a retry.
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

  // W-663 (SA-843 filing): an emptied edit field must CLEAR the stored value. The wrong value is pinned first: an absent key
  // (what the clients sent) keeps the old reference. A cleared reference has no dedupe identity (normalised ref null), so it
  // never trips DUPLICATE_PAYMENT_REF, even beside a same-amount payment that keeps the same reference.
  it("W-663 undefined keeps the old reference; null CLEARS reference and notes; clearing never trips the dedupe", async () => {
    const s = await seed("w663");
    const pay = await s.row(s.invs[0].id, { amount: 25, reference: "R9" });
    await s.row(s.invs[1].id, { amount: 25, reference: "R9" }); // the same reference and amount, elsewhere
    await prismaA.invoicePayment.update({ where: { id: pay.id }, data: { notes: "old note" } });
    const edit = (body: Record<string, unknown>) =>
      s
        .asTenant(() =>
          invoicesA.updatePayment(
            s.invs[0].id,
            pay.id,
            { amount: 25, method: "CHECK", ...body } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
    expect(status(await edit({ reference: undefined, notes: undefined }))).toBe("ok");
    expect((await s.get(pay.id))?.reference).toBe("R9"); // the wrong value the clients produced
    expect(status(await edit({ reference: null, notes: null }))).toBe("ok"); // no 409: no dedupe identity
    const after = await s.get(pay.id);
    expect(after?.reference).toBeNull();
    expect(after?.notes).toBeNull();
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

    it("G6 the group's excess advance makes the 409: X = $101; G $60 + $30 + a $10 advance, $30 -> $31", async () => {
      const s = await seed("g6");
      const g = randomUUID();
      await s.row(s.invs[0].id, { amount: 60, reference: "R9", paymentGroupId: g });
      const thirty = await s.row(s.invs[1].id, { amount: 30, reference: "R9", paymentGroupId: g });
      const x = await s.row(s.invs[2].id, { amount: 101, reference: "R9" });
      await s.advance(10, "R9");
      const err: any = await s
        .asTenant(() =>
          invoicesA.updatePayment(
            s.invs[1].id,
            thirty.id,
            { amount: 31, method: "CHECK", reference: "R9" } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
      expect(status(err)).toBe(409);
      expect(err.getResponse()).toMatchObject({ existingPayment: { id: x.id } });
      expect(Number((await s.get(thirty.id))?.amount)).toBe(30);
    }, 60_000);

    /** SA-867: G = $60 + $40 on "R9"; Y on "Q5" (another attempt). The $40 row's reference moves to "Q5". */
    async function moveOutOfGroup(label: string, yAmount: number) {
      const s = await seed(label);
      const g = randomUUID();
      await s.row(s.invs[0].id, { amount: 60, reference: "R9", paymentGroupId: g });
      const forty = await s.row(s.invs[1].id, { amount: 40, reference: "R9", paymentGroupId: g });
      const y = await s.row(s.invs[2].id, { amount: yAmount, reference: "Q5" });
      const err = await s
        .asTenant(() =>
          invoicesA.updatePayment(
            s.invs[1].id,
            forty.id,
            { amount: 40, method: "CHECK", reference: "Q5" } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
      return { s, forty, y, err };
    }

    it("G4 (SA-867) a grouped row whose reference MOVES is judged alone: $40 onto Y = $40 'Q5' is 409 naming Y", async () => {
      const { s, forty, y, err } = await moveOutOfGroup("g4", 40);
      expect(status(err)).toBe(409);
      expect((err as any).getResponse()).toMatchObject({ existingPayment: { id: y.id } });
      expect((await s.get(forty.id))?.reference).toBe("R9");
    }, 60_000);

    it("G5 (SA-867) the same move onto Y = $100 'Q5' is 200 (a $40 row is not a $100 payment)", async () => {
      const { s, forty, err } = await moveOutOfGroup("g5", 100);
      expect(status(err)).toBe("ok");
      expect((await s.get(forty.id))?.reference).toBe("Q5");
    }, 60_000);

    it("G3 with a $10 excess advance: an unchanged amount runs no check; $30 -> $31 (G + advance $101) is 200", async () => {
      const { s, thirty, edit } = await groupAndX("g3");
      await s.advance(10, "R9"); // G + advance = $100 already, equal to X: only a CHANGED key may be judged
      expect(status(await edit(30))).toBe("ok");
      expect(status(await edit(31))).toBe("ok");
      expect(Number((await s.get(thirty.id))?.amount)).toBe(31);
    }, 60_000);
  });

  describe("W-719 / SA-879: a group's own advance after an earlier paidAt edit", () => {
    const D0 = "2026-10-01T12:00:00.000Z";
    const D1 = "2026-10-05T12:00:00.000Z";
    /** A REAL standalone "W9" check: the allocations onto invoices 0.., the excess booked as the group's advance. */
    async function standalone(label: string, total: number, allocs: number[], opts?: any) {
      const s = await seed(label);
      await s.asTenant(() =>
        invoicesA.recordStandalonePayment(
          {
            customerId: s.customer.id,
            totalAmount: total,
            method: "CHECK",
            reference: "W9",
            paidAt: D0,
            allocations: allocs.map((amount, i) => ({ invoiceId: s.invs[i].id, amount })),
          } as any,
          opts,
        ),
      );
      const rows = await prismaA.invoicePayment.findMany({
        where: { invoice: { tenantId: s.tenant.id } },
        orderBy: { amount: "desc" },
      });
      const advs = await prismaA.advancePayment.findMany({ where: { customerId: s.customer.id } });
      const edit = (row: { id: string; invoiceId: string }, body: Record<string, unknown>) =>
        s
          .asTenant(() =>
            invoicesA.updatePayment(
              row.invoiceId,
              row.id,
              { method: "CHECK", reference: "W9", ...body } as any,
              s.staffOpts(false),
            ),
          )
          .catch((e) => e);
      return { s, rows, advs, edit };
    }

    it("the real writer links the excess advance to the group's first row (SA-879 rule 1)", async () => {
      const { rows, advs } = await standalone("w719-fx", 100, [60]);
      expect(rows).toHaveLength(1);
      expect(advs).toHaveLength(1);
      expect(Number(advs[0].amount)).toBe(40);
      expect(advs[0].sourcePaymentId).toBe(rows[0].id);
    }, 60_000);

    it("R1 a one-row group, its paidAt edited, then $60 -> $40: no self-409 (master: 409 naming its own advance)", async () => {
      const { s, rows, edit } = await standalone("w719-r1", 100, [60]);
      expect(status(await edit(rows[0], { amount: 60, paidAt: D1 }))).toBe("ok");
      expect(status(await edit(rows[0], { amount: 40 }))).toBe("ok");
      expect(Number((await s.get(rows[0].id))?.amount)).toBe(40);
    }, 60_000);

    it("R1b ...and it is judged at $40 + $40 = $80: X = $80 'W9' elsewhere makes it 409 naming X", async () => {
      const { s, rows, edit } = await standalone("w719-r1b", 100, [60]);
      const x = await s.row(s.invs[2].id, { amount: 80, reference: "W9" });
      expect(status(await edit(rows[0], { amount: 60, paidAt: D1 }))).toBe("ok");
      const err: any = await edit(rows[0], { amount: 40 });
      expect(status(err)).toBe(409);
      expect(err.getResponse()).toMatchObject({ existingPayment: { id: x.id } });
      expect(Number((await s.get(rows[0].id))?.amount)).toBe(60);
    }, 60_000);

    it("R2 the link survives a VOIDed first row: $60 (void) + $30 + a $10 advance; $30 -> $35 is judged at $45 (X = $45: 409)", async () => {
      const { s, rows, advs, edit } = await standalone("w719-r2", 100, [60, 30]);
      expect(advs[0].sourcePaymentId).toBe(rows[0].id); // the $60 row, the one voided next
      await prismaA.invoicePayment.update({ where: { id: rows[0].id }, data: { status: "VOID" } });
      const x = await s.row(s.invs[2].id, { amount: 45, reference: "W9" });
      const err: any = await edit(rows[1], { amount: 35 });
      expect(status(err)).toBe(409);
      expect(err.getResponse()).toMatchObject({ existingPayment: { id: x.id } });
    }, 60_000);

    it("R3 legacy (unlinked) advance: found by the OTHER row's original paidAt after this row's date was edited", async () => {
      const s = await seed("w719-r3");
      const g = randomUUID();
      await s.row(s.invs[0].id, { amount: 60, reference: "W9", paymentGroupId: g }); // keeps D0
      const thirty = await s.row(s.invs[1].id, { amount: 30, reference: "W9", paymentGroupId: g });
      await s.advance(10, "W9"); // receivedAt D0, sourcePaymentId null: booked before the link
      await prismaA.invoicePayment.update({
        where: { id: thirty.id },
        data: { paidAt: new Date(D1) },
      });
      const x = await s.row(s.invs[2].id, { amount: 105, reference: "W9" });
      const err: any = await s
        .asTenant(() =>
          invoicesA.updatePayment(
            s.invs[1].id,
            thirty.id,
            { amount: 35, method: "CHECK", reference: "W9" } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
      expect(status(err)).toBe(409); // $60 + $35 + the $10 legacy advance = X's $105
      expect(err.getResponse()).toMatchObject({ existingPayment: { id: x.id } });
    }, 60_000);

    it("R4 the fresh path: an edited-paidAt group + its linked advance; a NEW $100 'W9' payment is 409 naming the group (master: none)", async () => {
      const { s, rows, edit } = await standalone("w719-r4", 100, [60]);
      expect(status(await edit(rows[0], { amount: 60, paidAt: D1 }))).toBe("ok");
      const err: any = await s
        .asTenant(() =>
          invoicesA.recordPayment(
            s.invs[2].id,
            { amount: 100, method: "CHECK", reference: "W9" } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
      expect(status(err)).toBe(409);
      expect(err.getResponse()).toMatchObject({ existingPayment: { id: rows[0].id } });
      expect(await prismaA.invoicePayment.count({ where: { invoiceId: s.invs[2].id } })).toBe(0);
    }, 60_000);

    // SA-897 (N1): a HARD-deleted linked row (payment DELETE, invoice/order delete) leaves the link dangling; a dangling
    // link counts as unlinked, so the date rule finds the advance again. Only a dangling one: a live link to ANOTHER
    // group's row never attaches by date (R9).
    it("R7 the linked first row hard-deleted, then B $30 -> $10: no self-409 (head: 409 naming its own advance)", async () => {
      const { s, rows, advs, edit } = await standalone("w719-r7", 100, [60, 30]);
      expect(advs[0].sourcePaymentId).toBe(rows[0].id);
      await s.asTenant(() => invoicesA.deletePayment(rows[0].invoiceId, rows[0].id));
      const err: any = await edit(rows[1], { amount: 10 });
      expect(status(err)).toBe("ok");
      expect(Number((await s.get(rows[1].id))?.amount)).toBe(10);
    }, 60_000);

    it("R8 the linked first row hard-deleted, then a NEW 'W9' $40 = the group ($30 + its $10 advance): 409 naming the group (head: recorded)", async () => {
      const { s, rows } = await standalone("w719-r8", 100, [60, 30]);
      await s.asTenant(() => invoicesA.deletePayment(rows[0].invoiceId, rows[0].id));
      const err: any = await s
        .asTenant(() =>
          invoicesA.recordPayment(
            s.invs[2].id,
            { amount: 40, method: "CHECK", reference: "W9" } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
      expect(status(err)).toBe(409);
      expect(err.getResponse()).toMatchObject({ existingPayment: { id: rows[1].id } });
      expect(await prismaA.invoicePayment.count({ where: { invoiceId: s.invs[2].id } })).toBe(0);
    }, 60_000);

    it("R9 two same-reference groups on one day: group 1's live-linked advance never attaches to group 2 by date", async () => {
      const { s } = await standalone("w719-r9", 100, [60]); // group 1: $60 + a $40 advance linked to its row
      await s.asTenant(() =>
        invoicesA.recordStandalonePayment(
          {
            customerId: s.customer.id,
            totalAmount: 100,
            method: "CHECK",
            reference: "W9",
            paidAt: D0,
            allocations: [{ invoiceId: s.invs[1].id, amount: 60 }],
          } as any,
          s.staffOpts(true), // the repeat, recorded anyway: group 2, its own $40 advance
        ),
      );
      const g2row = await prismaA.invoicePayment.findFirstOrThrow({
        where: { invoiceId: s.invs[1].id },
      });
      // X = $150: group 2 at $70 + its $40 + group 1's $40 would equal it, but group 2 alone is $110
      await s.row(s.invs[2].id, { amount: 150, reference: "W9" });
      const err: any = await s
        .asTenant(() =>
          invoicesA.updatePayment(
            s.invs[1].id,
            g2row.id,
            { amount: 70, method: "CHECK", reference: "W9" } as any,
            s.staffOpts(false),
          ),
        )
        .catch((e) => e);
      expect(status(err)).toBe("ok");
    }, 60_000);

    it("R6 a forced retry of the standalone write: the committed advance links a COMMITTED row", async () => {
      let attempts = 0;
      const { rows, advs } = await standalone("w719-r6", 100, [60, 30], {
        inTx: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("forced conflict"), { code: "P2034" });
        },
      });
      expect(attempts).toBe(2);
      expect(rows).toHaveLength(2);
      expect(advs).toHaveLength(1);
      expect(rows.map((r) => r.id)).toContain(advs[0].sourcePaymentId);
    }, 60_000);
  });
});
