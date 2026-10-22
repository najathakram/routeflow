// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

// Row 498 / ruling 4: the reference serialisation is `withAdvisoryLock` (db-locks), never raw SQL. The mock records
// every lock and statement in order and THROWS if the customer merge lock ("order-merge") is taken while the
// payment-ref lock is held (the pinned lock order: merge BEFORE payment-ref).
const mockEvents: string[] = [];
const mockHeld: string[] = [];
/** SA-837b item 4: how many of the next lock attempts abort with a Postgres deadlock (40P01). */
let mockLockFailures = 0;
/** How many of the next transactions fail AT COMMIT with a Postgres deadlock (40P01), after their body ran (rolled back). */
let mockCommitFailures = 0;
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (opts: { family: string; key: string }, fn: () => unknown) => {
    if (opts.family === "order-merge" && mockHeld.includes("payment-ref"))
      throw new Error("LOCK ORDER INVERTED: order-merge taken inside payment-ref");
    if (mockLockFailures > 0) {
      mockLockFailures -= 1;
      mockEvents.push("lock:fail");
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    }
    mockEvents.push(`lock:${opts.family}:${opts.key}`);
    mockHeld.push(opts.family);
    try {
      return { acquired: true, value: await fn() };
    } finally {
      mockHeld.pop();
      mockEvents.push(`unlock:${opts.family}`);
    }
  }),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";

/**
 * Row 498 (SA-837), on top of SA-824's one recording path: with a payment reference, a payment is a
 * DUPLICATE when (tenant, customer, method, NORMALISED reference, amount) already exists on a non-VOID
 * payment OF ANOTHER ATTEMPT, with NO time window. The writers (`recordPayment`, `recordStandalonePayment`)
 * refuse it 409 DUPLICATE_PAYMENT_REF naming the existing payment, unless a STAFF caller sends
 * `recordAnyway`, which saves it and writes exactly one audit row. The rule is the same for every caller
 * (the counter included, no opt-in); the shared walk-in identity is never deduped; the payments of one
 * attempt (a shared `paymentAttempt`, a `paymentGroupId`, one standalone group) never collide.
 *
 * Drives the REAL writers over a transactional in-memory ledger (a throw leaves nothing, as in
 * Postgres). It imports nothing that is new with row 498 and passes the option through `as any` (the
 * code is a string literal), so it runs unchanged on master, where it FAILS for the bug itself: the
 * second payment under the same reference is recorded. The real-Postgres cases (a day-later repeat and
 * the two-connection race) are payment-ref-dedupe.db.spec.ts (NEED-DB).
 */

const DUP = "DUPLICATE_PAYMENT_REF";
const STAFF = { actor: "user-staff", role: "OPERATOR" };
const SOMEONE = { actor: "u-9", role: "CUSTOMER" };

interface KeyRow {
  id: string;
  tenantId: string;
  key: string;
  scope: string | null;
  requestHash: string | null;
  result: unknown;
  state?: string;
}
interface Stage {
  pays: any[];
  advs: any[];
  keys: KeyRow[];
  audits: any[];
}

describe("row 498: payments dedupe on a normalised reference (no window), on SA-824's path", () => {
  let invoices: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: Stage;
  let stage: Stage | null;
  let tenant: string;
  let seq: number;
  /** Every lock and raw statement, in order (the lock-order pin). */
  let rawLog: string[];
  /** invoice id -> who owns it. */
  let invoiceDir: Record<string, { customerId: string; invoiceNumber: string }>;

  const sqlOf = (strings: TemplateStringsArray | string[]) => Array.from(strings).join("?");

  function installLedger() {
    ledger = { pays: [], advs: [], keys: [], audits: [] };
    stage = null;
    tenant = "tenant-a";
    seq = 0;
    rawLog = mockEvents;
    rawLog.length = 0;
    mockHeld.length = 0;
    mockLockFailures = 0;
    mockCommitFailures = 0;
    invoiceDir = {
      "inv-1": { customerId: "cust-1", invoiceNumber: "INV-0001" },
      "inv-2": { customerId: "cust-1", invoiceNumber: "INV-0002" },
      "inv-other": { customerId: "cust-2", invoiceNumber: "INV-0003" },
      "walk-1": { customerId: "cust-walk", invoiceNumber: "INV-0010" },
      "walk-2": { customerId: "cust-walk", invoiceNumber: "INV-0011" },
    };
    prisma.getTenantId.mockImplementation(() => tenant);

    const raw = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...v: any[]) => {
        rawLog.push(sqlOf(strings));
        if (!sqlOf(strings).includes('INSERT INTO "PaymentIdempotencyKey"')) return [];
        const [id, tenantId, key, scope, requestHash] = v;
        const all = [...ledger.keys, ...(stage?.keys ?? [])];
        if (all.some((k) => k.tenantId === tenantId && k.key === key)) return [];
        stage!.keys.push({ id, tenantId, key, scope, requestHash, result: {}, state: "CLAIMED" });
        return [{ id }];
      }),
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...v: any[]) => {
        rawLog.push(sqlOf(strings));
        if (!sqlOf(strings).includes('UPDATE "PaymentIdempotencyKey"')) return 0;
        const [result, , , id, tenantId] = v;
        const row = stage!.keys.find((k) => k.id === id && k.tenantId === tenantId);
        if (!row) return 0;
        Object.assign(row, { result: JSON.parse(result), state: "COMPLETED" });
        return 1;
      }),
    };
    prisma.tenantTransaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
      stage = { pays: [], advs: [], keys: [], audits: [] };
      try {
        const out = await fn({ ...prisma, ...raw });
        if (mockCommitFailures > 0) {
          mockCommitFailures -= 1;
          throw Object.assign(new Error("deadlock detected at commit"), { code: "40P01" });
        }
        ledger.pays.push(...stage.pays);
        ledger.advs.push(...stage.advs);
        ledger.keys.push(...stage.keys);
        ledger.audits.push(...stage.audits);
        return out;
      } finally {
        stage = null;
      }
    });

    prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
      const row = { id: `pay-${++seq}`, ...data };
      (stage?.pays ?? ledger.pays).push({ ...row, tenantId: tenant });
      return row;
    });
    prisma.advancePayment.create.mockImplementation(async ({ data }: any) => {
      const row = { id: `adv-${++seq}`, ...data };
      (stage?.advs ?? ledger.advs).push({ ...row, tenantId: tenant });
      return row;
    });
    prisma.auditLog.create.mockImplementation(async ({ data }: any) => {
      (stage?.audits ?? ledger.audits).push({ ...data, tenantId: tenant });
      return data;
    });
    // The replay's status re-read (by id) AND the reference dedupe's candidate read (by customer + method).
    prisma.invoicePayment.findMany.mockImplementation(async (a: any) => {
      const ids: string[] | undefined = a?.where?.id?.in;
      if (ids) return ledger.pays.filter((p) => ids.includes(p.id));
      const cust: string | undefined = a?.where?.invoice?.customerId;
      if (!cust) return [];
      return ledger.pays
        .filter(
          (p) =>
            p.tenantId === tenant &&
            invoiceDir[p.invoiceId]?.customerId === cust &&
            p.method === a.where.method &&
            p.status !== "VOID" &&
            p.reference != null &&
            // M4: the cheap DB prefilter: the same amount, or a member of a payment group
            (a.where.OR
              ? a.where.OR.some(
                  (c: any) =>
                    (c.amount !== undefined && Number(p.amount) === Number(c.amount)) ||
                    (c.paymentGroupId !== undefined && p.paymentGroupId != null) ||
                    (c.reference !== undefined && p.reference === c.reference),
                )
              : true),
        )
        .map((p) => ({ ...p, invoice: { invoiceNumber: invoiceDir[p.invoiceId].invoiceNumber } }));
    });
    prisma.advancePayment.findMany.mockImplementation(async (a: any) =>
      ledger.advs.filter(
        (r) =>
          r.tenantId === tenant &&
          r.customerId === a?.where?.customerId &&
          r.method === a?.where?.method,
      ),
    );
    prisma.advancePayment.findFirst.mockImplementation(async (a: any) => {
      const row = ledger.advs.find(
        (r) =>
          r.tenantId === tenant &&
          (a?.where?.id !== undefined
            ? r.id === a.where.id
            : r.customerId === a?.where?.customerId && r.reference === a?.where?.reference),
      );
      return row ? { id: row.id, balance: row.balance } : null;
    });
    const keyStore = {
      findFirst: jest.fn(async (a: any) => {
        const row = ledger.keys.find((k) => k.tenantId === tenant && k.key === a?.where?.key);
        return row ? { ...row } : null;
      }),
    };
    prisma.forTenant.mockImplementation((() => ({
      ...prisma,
      paymentIdempotencyKey: keyStore,
    })) as unknown as typeof prisma.forTenant);

    const invoiceOf = (id: string) => ({
      id,
      customerId: invoiceDir[id]?.customerId,
      invoiceNumber: invoiceDir[id]?.invoiceNumber,
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: null,
      payments: [],
    });
    prisma.invoice.findFirst.mockImplementation(async (a: any) =>
      invoiceOf(a?.where?.id ?? "inv-1"),
    );
    prisma.invoice.findUnique.mockImplementation(async (a: any) => invoiceOf(a?.where?.id));
    prisma.invoice.update.mockImplementation(async (a: any) => ({
      ...invoiceOf(a?.where?.id),
      status: InvoiceStatus.PARTIAL,
    }));
  }

  const committed = () => ({
    pays: ledger.pays.filter((p) => p.tenantId === tenant),
    advs: ledger.advs.filter((a) => a.tenantId === tenant),
    audits: ledger.audits.filter((a) => a.tenantId === tenant),
  });
  const refAudits = () =>
    committed().audits.filter((a) => String(a.action).includes("ref-record-anyway"));

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        CustomersService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: { sendInvoice: jest.fn(), send: jest.fn() } },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn(), set: jest.fn() } },
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
          useValue: { autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0 }) },
        },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
      ],
    }).compile();
    invoices = module.get(InvoicesService);

    installLedger();
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "tenant-a", next: 3 });
    prisma.customer.findUnique.mockImplementation(async (a: any) => ({
      id: a?.where?.id,
      isWalkIn: a?.where?.id === "cust-walk",
    }));
  });

  const dto = (over: Record<string, unknown> = {}) =>
    ({ amount: 100, method: "CHECK", reference: "CHK-7788", paidAt: "2026-10-01", ...over }) as any;
  /** `as any`: master's writers take no `refDedupe` / `paymentAttempt` and ignore them. */
  const as = (opts: Record<string, unknown> = {}) => opts as any;
  const record = (
    id: string,
    over: Record<string, unknown> = {},
    opts: Record<string, unknown> = {},
  ) => invoices.recordPayment(id, dto(over), as(opts));
  const dupOf = async (p: Promise<unknown>) => {
    const err: any = await p.catch((e) => e);
    return err;
  };

  describe("POST /invoices/:id/payments (recordPayment)", () => {
    it("(1) the same reference, amount, customer and method a DAY later is 409 DUPLICATE_PAYMENT_REF naming the first payment", async () => {
      await record("inv-1", { paidAt: "2026-10-01" });

      const err = await dupOf(record("inv-2", { paidAt: "2026-10-02" }));

      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: DUP,
        existingPayment: {
          id: "pay-1",
          amount: 100,
          invoiceId: "inv-1",
          invoiceNumber: "INV-0001",
        },
      });
      expect(new Date(err.getResponse().existingPayment.paidAt).toISOString()).toContain(
        "2026-10-01",
      );
      expect(committed().pays).toHaveLength(1); // nothing was written by the refused attempt
    });

    it("(2) the same reference with a different customer, a different amount or a different method is allowed", async () => {
      await record("inv-1");
      await record("inv-other"); // a different customer
      await record("inv-2", { amount: 50 }); // a different amount
      await record("inv-2", { method: "ACH" }); // a different method
      expect(committed().pays).toHaveLength(4);
    });

    it("(3) recordAnyway by staff saves the repeat and writes exactly ONE audit row", async () => {
      await record("inv-1");

      await record("inv-2", {}, { refDedupe: { ...STAFF, recordAnyway: true } });

      expect(committed().pays).toHaveLength(2);
      expect(refAudits()).toHaveLength(1);
      expect(refAudits()[0]).toMatchObject({
        userId: "user-staff",
        entityId: "inv-2",
        meta: expect.objectContaining({
          invoiceId: "inv-2",
          actor: "user-staff",
          normalisedRef: "CHK7788",
          duplicateOfPaymentId: "pay-1",
        }),
      });
    });

    it("(3) recordAnyway from a non-staff role is ignored: 409 and no audit row", async () => {
      await record("inv-1");

      const err = await dupOf(
        record("inv-2", {}, { refDedupe: { ...SOMEONE, recordAnyway: true } }),
      );

      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: DUP });
      expect(committed().pays).toHaveLength(1);
      expect(refAudits()).toHaveLength(0);
    });

    it("(3) recordAnyway on a payment that is NOT a duplicate writes no audit row", async () => {
      await record("inv-1", {}, { refDedupe: { ...STAFF, recordAnyway: true } });
      expect(committed().pays).toHaveLength(1);
      expect(refAudits()).toHaveLength(0);
    });

    it.each([["abc-123"], [" ABC 123 "], ["Abc123"], ["a b-c 1-2 3"]])(
      "(4) %j is the same reference as the first payment recorded as abc-123",
      async (second) => {
        await record("inv-1", { reference: "abc-123" });
        const err = await dupOf(record("inv-2", { reference: second }));
        expect(err?.getStatus?.()).toBe(409);
        expect(err.getResponse()).toMatchObject({ code: DUP });
      },
    );

    it("(5) no reference: nothing is deduped, exactly as today (a blank reference is no reference)", async () => {
      await record("inv-1", { reference: undefined });
      await record("inv-1", { reference: undefined });
      await record("inv-2", { reference: "   " });
      await record("inv-2", { reference: "---" });
      expect(committed().pays).toHaveLength(4);
      expect(refAudits()).toHaveLength(0);
    });

    it("(6) an SA-824 replay with the same Idempotency-Key replays; it never hits the reference dedupe", async () => {
      const first: any = await record("inv-1", {}, { idempotencyKey: "key-a" });
      const again: any = await record("inv-1", {}, { idempotencyKey: "key-a" });

      expect(again.replayed).toBe(true);
      expect(again.createdPaymentId).toBe(first.createdPaymentId);
      expect(committed().pays).toHaveLength(1);
    });

    it("(6) a NEW attempt (a new key) with the same reference is refused, and the refusal does not burn its key", async () => {
      await record("inv-1", {}, { idempotencyKey: "key-a" });

      const err = await dupOf(record("inv-2", {}, { idempotencyKey: "key-b" }));
      expect(err?.getResponse?.()).toMatchObject({ code: DUP });
      expect(ledger.keys.map((k) => k.key)).toEqual(["key-a"]); // key-b's claim rolled back with the refusal

      // The staff "record anyway" resend may reuse the same key: it records once.
      await record(
        "inv-2",
        {},
        { idempotencyKey: "key-b", refDedupe: { ...STAFF, recordAnyway: true } },
      );
      expect(committed().pays).toHaveLength(2);
      expect(refAudits()).toHaveLength(1);
    });

    it("(7) a VOID earlier payment does not count; a PENDING or DRAFT one does", async () => {
      await record("inv-1");
      ledger.pays[0].status = "VOID";
      await record("inv-2"); // allowed: the only earlier one is VOID
      expect(committed().pays).toHaveLength(2);

      ledger.pays[1].status = "PENDING";
      expect((await dupOf(record("inv-2")))?.getResponse?.()).toMatchObject({ code: DUP });
      ledger.pays[1].status = "DRAFT";
      expect((await dupOf(record("inv-2")))?.getResponse?.()).toMatchObject({ code: DUP });
      expect(committed().pays).toHaveLength(2);
    });

    it("(8) there is no opt-in: a caller with only counter options (no refDedupe) is deduped like any other, for an account customer", async () => {
      await invoices.recordPayment("inv-1", dto(), { tillLockHeld: true } as any);
      const err = await dupOf(
        invoices.recordPayment("inv-2", dto(), { tillLockHeld: true } as any),
      );
      expect(err?.getResponse?.()).toMatchObject({ code: DUP });
      expect(committed().pays).toHaveLength(1);
    });

    it("(9) the reference lock is withAdvisoryLock(payment-ref, tenant:method:normRef), opened before the tx; the key claim and the Invoice row lock run inside it", async () => {
      await record("inv-1", { reference: "chk-77 88" }, { idempotencyKey: "key-a" });
      const at = (needle: string) => rawLog.findIndex((s) => s.includes(needle));
      expect(rawLog[0]).toBe("lock:payment-ref:tenant-a:CHECK:CHK7788");
      expect(at("INSERT INTO")).toBeGreaterThan(at("lock:payment-ref"));
      expect(at('FROM "Invoice" WHERE id')).toBeGreaterThan(at("INSERT INTO"));
      expect(at("unlock:payment-ref")).toBeGreaterThan(at('FROM "Invoice" WHERE id'));
      expect(rawLog.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(false); // never raw SQL
    });

    it("(9) a replay of the same key and a payment with no reference take no reference lock", async () => {
      await record("inv-1", {}, { idempotencyKey: "key-a" });
      rawLog.length = 0;
      await record("inv-1", {}, { idempotencyKey: "key-a" }); // replay
      await record("inv-2", { reference: undefined });
      expect(rawLog.filter((s) => s.startsWith("lock:"))).toEqual([]);
    });

    it("(9) lock order: the customer merge lock taken BEFORE the payment-ref lock is fine; the inverse throws", async () => {
      const { withAdvisoryLock } = jest.requireMock("../common/db-locks");
      await withAdvisoryLock({ family: "order-merge", key: "cust-1" }, () => record("inv-1"));
      expect(committed().pays).toHaveLength(1);
      await expect(
        withAdvisoryLock({ family: "payment-ref", key: "x" }, () =>
          withAdvisoryLock({ family: "order-merge", key: "cust-1" }, async () => undefined),
        ),
      ).rejects.toThrow("LOCK ORDER INVERTED");
    });

    it("(S1) two equal-amount payments of ONE attempt (a shared paymentAttempt: counter tender over sibling invoices) both record", async () => {
      const attempt = { ids: new Set<string>() };
      await record("inv-1", {}, { paymentAttempt: attempt });
      await record("inv-2", {}, { paymentAttempt: attempt });
      expect(committed().pays).toHaveLength(2);
      expect([...attempt.ids]).toEqual(["pay-1", "pay-2"]);
      // ... and the next, separate attempt is a duplicate of them.
      expect((await dupOf(record("inv-1")))?.getResponse?.()).toMatchObject({ code: DUP });
    });

    it("(S2) a resumed attempt: earlier stored tender rows seeded into the attempt do not collide with the shortfall payment", async () => {
      await record("inv-1"); // the sale's first call paid sibling 1 and failed on sibling 2
      const resumed = { ids: new Set<string>(["pay-1"]) };
      await record("inv-2", {}, { paymentAttempt: resumed });
      expect(committed().pays).toHaveLength(2);
    });

    it("(S3) rows sharing the call's paymentGroupId are one attempt (pickup-complete's tender group)", async () => {
      await record("inv-1", {}, { paymentGroupId: "grp-1" });
      await record("inv-2", {}, { paymentGroupId: "grp-1" });
      expect(committed().pays).toHaveLength(2);
      // the two rows are ONE payment of 200: another group's 200 with the same reference is a duplicate of it
      expect(
        (await dupOf(record("inv-1", { amount: 200 }, { paymentGroupId: "grp-2" })))?.getStatus?.(),
      ).toBe(409);
    });

    it("(W1) the shared walk-in identity is never deduped: two walk-in sales, same method, reference and amount, both record", async () => {
      await record("walk-1", { method: "CARD", reference: "4242" }, { tillLockHeld: true });
      await record("walk-2", { method: "CARD", reference: "4242" }, { tillLockHeld: true });
      expect(committed().pays).toHaveLength(2);
      expect(refAudits()).toHaveLength(0);
    });

    it("(W2) an account buyer at the counter is deduped exactly like anywhere else: the second payment is 409", async () => {
      await record("inv-1", { method: "CARD", reference: "4242" }, { tillLockHeld: true });
      const err = await dupOf(
        record("inv-2", { method: "CARD", reference: "4242" }, { tillLockHeld: true }),
      );
      expect(err?.getResponse?.()).toMatchObject({ code: DUP });
    });
  });

  describe("SA-837b item 4: every payment-ref lock path runs inside the transaction-retry wrapper", () => {
    it("(R1) a Postgres deadlock abort (40P01) of the first try is retried: recorded once", async () => {
      mockLockFailures = 1;
      await record("inv-1");
      expect(committed().pays).toHaveLength(1);
      expect(rawLog.filter((s) => s === "lock:fail")).toHaveLength(1);
      expect(rawLog.filter((s) => s.startsWith("lock:payment-ref"))).toHaveLength(1);
    });

    it("(R2) retries exhausted: a retryable 503 LOCK_UNAVAILABLE and nothing recorded", async () => {
      mockLockFailures = 9;
      const err = await dupOf(record("inv-1"));
      expect(err?.getStatus?.()).toBe(503);
      expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
      expect(committed().pays).toHaveLength(0);
    });

    it("(R3) the standalone writer's lock path retries too", async () => {
      mockLockFailures = 1;
      await invoices.recordStandalonePayment(
        {
          customerId: "cust-1",
          totalAmount: 100,
          method: "CHECK",
          reference: "CHK-7788",
          paidAt: "2026-10-01",
          allocations: [{ invoiceId: "inv-1", amount: 100 }],
        } as any,
        {} as any,
      );
      expect(committed().pays).toHaveLength(1);
    });
  });

  describe("M4: the candidate read is prefiltered in the database", () => {
    it("asks for the same amount, or a member of a payment group, never every referenced payment of the customer", async () => {
      await record("inv-1", { amount: 100 });
      prisma.invoicePayment.findMany.mockClear();
      await record("inv-2", { amount: 55.5, reference: "OTHER-1" });
      const call = prisma.invoicePayment.findMany.mock.calls.find((c) => c[0]?.where?.invoice);
      expect(call![0].where.OR).toEqual([{ amount: 55.5 }, { paymentGroupId: { not: null } }]);
    });
  });

  describe("SA-837b item 1: Stripe-captured money is recorded and flagged, never refused", () => {
    const capture = (sourceRef: string) => ({
      capturedExternally: { source: "STRIPE", sourceRef, suspects: [] as any[] },
    });
    const card = (over: Record<string, unknown> = {}) =>
      ({
        customerId: "cust-1",
        totalAmount: 100,
        method: "CREDIT_CARD",
        reference: " PI_3ABC ",
        paidAt: "2026-10-01",
        allocations: [{ invoiceId: "inv-1", amount: 100 }],
        ...over,
      }) as any;
    const suspectAudits = () =>
      committed().audits.filter((a) => String(a.action) === "payment.ref-duplicate-suspect");

    it("(E1) a capture that repeats an existing payment's normalised reference + amount is RECORDED, flagged by one audit row and a suspect, never 409", async () => {
      await invoices.recordStandalonePayment(card(), {} as any); // a manual repeat-able payment
      const opts = capture("pi_3Abc"); // the exact-equal check below is by RAW text; this differs in case/spaces
      const res: any = await invoices.recordStandalonePayment(
        card({ reference: "pi_3Abc" }),
        opts as any,
      );
      expect(res.paymentGroupId).toBeTruthy();
      expect(committed().pays).toHaveLength(2);
      expect(suspectAudits()).toHaveLength(1);
      expect(suspectAudits()[0].meta).toMatchObject({
        source: "STRIPE",
        paymentIntentId: "pi_3Abc",
        duplicateOfPaymentId: "pay-1",
        normalisedRef: "PI_3ABC",
      });
      expect(opts.capturedExternally.suspects).toEqual([
        expect.objectContaining({
          duplicateOfPaymentId: "pay-1",
          invoiceId: "inv-1",
          paymentIds: ["pay-2"],
        }),
      ]);
    });

    it("(E2) the SAME payment intent already recorded: a PaymentAlreadyRecordedError naming its group, nothing written", async () => {
      const first: any = await invoices.recordStandalonePayment(
        card({ reference: "pi_3Abc" }),
        capture("pi_3Abc") as any,
      );
      const err: any = await invoices
        .recordStandalonePayment(card({ reference: "pi_3Abc" }), capture("pi_3Abc") as any)
        .catch((e) => e);
      expect(err?.name).toBe("PaymentAlreadyRecordedError");
      expect(err.paymentGroupId).toBe(first.paymentGroupId);
      expect(committed().pays).toHaveLength(1);
      expect(suspectAudits()).toHaveLength(0);
    });

    it("(E3) a capture with nothing to repeat records quietly: no audit row, no suspect", async () => {
      const opts = capture("pi_new");
      await invoices.recordStandalonePayment(card({ reference: "pi_new" }), opts as any);
      expect(committed().pays).toHaveLength(1);
      expect(suspectAudits()).toHaveLength(0);
      expect(opts.capturedExternally.suspects).toHaveLength(0);
    });

    it("m1: a rolled-back attempt's suspect never survives a retry: the caller sees exactly the committed one", async () => {
      await invoices.recordStandalonePayment(card(), {} as any); // the payment the capture repeats
      mockCommitFailures = 1; // the first attempt flags a suspect, then the commit is aborted by a deadlock
      const opts = capture("pi_3Abc");
      await invoices.recordStandalonePayment(card({ reference: "pi_3Abc" }), opts as any);
      expect(committed().pays).toHaveLength(2);
      expect(suspectAudits()).toHaveLength(1);
      expect(opts.capturedExternally.suspects).toHaveLength(1); // not 2: the rolled-back attempt's is gone
    });

    it("m1: a stale suspect left on the capture is cleared by the next check", async () => {
      const opts = capture("pi_clean");
      opts.capturedExternally.suspects.push({
        paymentIds: ["old"],
        invoiceId: "x",
        duplicateOfPaymentId: "y",
      });
      await invoices.recordStandalonePayment(card({ reference: "pi_clean" }), opts as any);
      expect(opts.capturedExternally.suspects).toHaveLength(0);
    });

    it("m2: an all-excess charge (an AdvancePayment with the source reference) is not booked a second time", async () => {
      // the first delivery booked ONLY an advance (no open invoice): there is no InvoicePayment row to dedupe against
      ledger.advs.push({
        id: "adv-old",
        tenantId: tenant,
        customerId: "cust-1",
        method: "CREDIT_CARD",
        reference: "pi_adv",
        amount: 100,
        balance: 100,
      });
      const err: any = await invoices
        .recordStandalonePayment(
          card({ reference: "pi_adv", allocations: [] }),
          capture("pi_adv") as any,
        )
        .catch((e) => e);
      expect(err?.name).toBe("PaymentAlreadyRecordedError");
      expect(committed().advs).toHaveLength(1);
    });

    it("m2: the advance match is the EXACT source reference, for this customer", async () => {
      ledger.advs.push({
        id: "adv-other",
        tenantId: tenant,
        customerId: "cust-2",
        method: "CREDIT_CARD",
        reference: "pi_adv",
        amount: 100,
        balance: 100,
      });
      await invoices.recordStandalonePayment(
        card({ reference: "pi_adv", allocations: [] }),
        capture("pi_adv") as any,
      );
      expect(committed().advs.length).toBeGreaterThanOrEqual(2);
    });

    it("m3: the same charge recorded earlier at a DIFFERENT amount is still the same charge: already recorded, nothing booked", async () => {
      const first: any = await invoices.recordStandalonePayment(
        card({ reference: "pi_same" }),
        capture("pi_same") as any,
      );
      const err: any = await invoices
        .recordStandalonePayment(
          card({
            reference: "pi_same",
            totalAmount: 150,
            allocations: [{ invoiceId: "inv-1", amount: 100 }],
          }),
          capture("pi_same") as any,
        )
        .catch((e) => e);
      expect(err?.name).toBe("PaymentAlreadyRecordedError");
      expect(err.paymentGroupId).toBe(first.paymentGroupId);
      expect(committed().pays).toHaveLength(1);
    });

    it("m3: ... even when another candidate event is the amount hit", async () => {
      await invoices.recordStandalonePayment(card({ reference: " PI_SAME " }), {} as any); // a manual 100, normalises equal
      await invoices.recordStandalonePayment(
        card({
          reference: "pi_same",
          totalAmount: 60,
          allocations: [{ invoiceId: "inv-1", amount: 60 }],
        }),
        capture("pi_same") as any,
      );
      const opts = capture("pi_same");
      const err: any = await invoices
        .recordStandalonePayment(card({ reference: "pi_same" }), opts as any)
        .catch((e) => e);
      // the amount hit is the manual 100 (a suspect), but the exact-reference 60 proves this charge is already on the ledger
      expect(err?.name).toBe("PaymentAlreadyRecordedError");
      expect(opts.capturedExternally.suspects).toHaveLength(0);
    });

    it("(E4) the exemption is structural: the same repeat from a manual caller (recordAnyway or not) is still 409 without it", async () => {
      await invoices.recordStandalonePayment(card(), {} as any);
      const err: any = await invoices.recordStandalonePayment(card(), {} as any).catch((e) => e);
      expect(err?.getResponse?.()).toMatchObject({ code: DUP });
    });
  });

  describe("POST /invoices/payments/record (recordStandalonePayment)", () => {
    const standalone = (over: Record<string, unknown> = {}) =>
      ({
        customerId: "cust-1",
        totalAmount: 150,
        method: "CHECK",
        reference: "CHK-7788",
        paidAt: "2026-10-01",
        allocations: [{ invoiceId: "inv-1", amount: 100 }],
        ...over,
      }) as any;
    const recordGroup = (over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
      invoices.recordStandalonePayment(standalone(over), as(opts));

    it("(1) the same reference and total a day later is 409, naming the first payment group, excess included", async () => {
      await recordGroup({ paidAt: "2026-10-01" }); // 100 to the invoice + 50 on account

      const err = await dupOf(recordGroup({ paidAt: "2026-10-02" }));

      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: DUP,
        existingPayment: { id: "pay-1", amount: 150, invoiceNumber: "INV-0001" },
      });
      expect(committed().pays).toHaveLength(1);
      expect(committed().advs).toHaveLength(1);
    });

    it("(2) a different customer, amount or method is allowed", async () => {
      await recordGroup();
      await recordGroup({
        customerId: "cust-2",
        allocations: [{ invoiceId: "inv-other", amount: 100 }],
      });
      await recordGroup({ totalAmount: 120 });
      await recordGroup({ method: "ACH" });
      expect(committed().pays).toHaveLength(4);
    });

    it("(3) recordAnyway by staff saves the repeat with ONE audit row (however many allocations); non-staff gets 409", async () => {
      await recordGroup();
      const two = {
        totalAmount: 150,
        allocations: [
          { invoiceId: "inv-1", amount: 100 },
          { invoiceId: "inv-2", amount: 50 },
        ],
      };

      const refused = await dupOf(
        recordGroup(two, { refDedupe: { actor: "u-9", role: "DRIVER", recordAnyway: true } }),
      );
      expect(refused?.getResponse?.()).toMatchObject({ code: DUP });
      expect(refAudits()).toHaveLength(0);

      await recordGroup(two, { refDedupe: { ...STAFF, recordAnyway: true } });
      expect(refAudits()).toHaveLength(1);
      expect(refAudits()[0].meta).toMatchObject({
        normalisedRef: "CHK7788",
        actor: "user-staff",
        duplicateOfPaymentId: "pay-1",
      });
    });

    it("(4) the normalised reference matches", async () => {
      await recordGroup({ reference: "chk 77-88" });
      const err = await dupOf(recordGroup({ reference: " Chk7788 " }));
      expect(err?.getResponse?.()).toMatchObject({ code: DUP });
    });

    it("(5) no reference: not deduped", async () => {
      await recordGroup({ reference: undefined });
      await recordGroup({ reference: undefined });
      expect(committed().pays).toHaveLength(2);
    });

    it("(6) a replay with the same Idempotency-Key replays and is never refused as a duplicate reference", async () => {
      const first: any = await recordGroup({}, { idempotencyKey: "key-s" });
      const again: any = await recordGroup({}, { idempotencyKey: "key-s" });
      expect(again.replayed).toBe(true);
      expect(again.paymentGroupId).toBe(first.paymentGroupId);
      expect(committed().pays).toHaveLength(1);
    });

    it("(7) a VOID earlier payment does not count", async () => {
      await recordGroup();
      ledger.pays[0].status = "VOID";
      await recordGroup();
      expect(committed().pays).toHaveLength(2);
    });

    it("(8) there is no opt-in: a plain caller (cash approval, Stripe settle) is deduped like any other", async () => {
      await invoices.recordStandalonePayment(standalone(), { actor: null } as any);
      const err = await dupOf(
        invoices.recordStandalonePayment(standalone(), { actor: null } as any),
      );
      expect(err?.getResponse?.()).toMatchObject({ code: DUP });
      expect(committed().pays).toHaveLength(1);
    });

    it("(S4) equal-amount allocations of ONE standalone payment both record (siblings never collide)", async () => {
      await recordGroup({
        totalAmount: 100,
        allocations: [
          { invoiceId: "inv-1", amount: 50 },
          { invoiceId: "inv-2", amount: 50 },
        ],
      });
      expect(committed().pays).toHaveLength(2);
      expect(committed().advs).toHaveLength(0);
    });

    it("(W1) a walk-in customer is never deduped", async () => {
      const walk = {
        customerId: "cust-walk",
        totalAmount: 100,
        allocations: [{ invoiceId: "walk-1", amount: 100 }],
      };
      await recordGroup(walk);
      await recordGroup(walk);
      expect(committed().pays).toHaveLength(2);
    });

    it("(9) the reference lock opens before the tx and the key claim runs inside it", async () => {
      await recordGroup({}, { idempotencyKey: "key-s" });
      expect(rawLog[0]).toBe("lock:payment-ref:tenant-a:CHECK:CHK7788");
      expect(rawLog.findIndex((s) => s.includes("INSERT INTO"))).toBeGreaterThan(0);
    });
  });
});
