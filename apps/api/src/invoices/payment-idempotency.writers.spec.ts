// Prevent Jest from traversing ESM-only dependencies (mirrors invoices.service.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
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
 * SA-824 (row 661 step 1): a duplicate submit of a customer money-in writer with the same
 * `Idempotency-Key` records ONE payment set. Drives the REAL writers (`recordStandalonePayment`,
 * `recordPayment`, `createAdvancePayment`) over a transactional in-memory ledger: every money row
 * and every key row written inside a transaction is staged and only lands on commit, so a throw
 * after the claim (MUST d) leaves neither. The key claim is the writer's raw
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, answered by the fake from the committed rows.
 *
 * It imports nothing that is new with SA-824 and passes the key through `as any`, so it runs
 * unchanged on master, where it fails for the bug itself: two submits write two payment sets.
 * The real-Postgres two-connection race (MUST b) is payment-idempotency.db.spec.ts.
 */

const CONFLICT = "IDEMPOTENCY_KEY_CONFLICT";

interface KeyRow {
  id: string;
  tenantId: string;
  key: string;
  scope: string;
  requestHash: string;
  result: unknown;
  paymentGroupId?: string | null;
  advancePaymentId?: string | null;
}
interface Stage {
  pays: any[];
  advs: any[];
  keys: KeyRow[];
}

describe("SA-824 customer money-in writers replay on the Idempotency-Key", () => {
  let invoices: InvoicesService;
  let customers: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: Stage;
  let stage: Stage | null;
  let tenant: string;
  let seq: number;
  /** When set, the next commission sync (after the claim and the payment rows) throws once. */
  let failAfterClaim: boolean;

  const sqlOf = (strings: TemplateStringsArray | string[]) => Array.from(strings).join("?");

  function installLedger() {
    ledger = { pays: [], advs: [], keys: [] };
    stage = null;
    tenant = "tenant-a";
    seq = 0;
    failAfterClaim = false;
    prisma.getTenantId.mockImplementation(() => tenant);

    const raw = {
      $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...v: any[]) => {
        if (!sqlOf(strings).includes('INSERT INTO "PaymentIdempotencyKey"')) return [];
        const [id, tenantId, key, scope, requestHash] = v;
        const all = [...ledger.keys, ...(stage?.keys ?? [])];
        if (all.some((k) => k.tenantId === tenantId && k.key === key)) return [];
        stage!.keys.push({ id, tenantId, key, scope, requestHash, result: {} });
        return [{ id }];
      }),
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...v: any[]) => {
        if (!sqlOf(strings).includes('UPDATE "PaymentIdempotencyKey"')) return 0;
        const [result, paymentGroupId, advancePaymentId, id, tenantId] = v;
        const row = stage!.keys.find((k) => k.id === id && k.tenantId === tenantId);
        if (!row) return 0;
        Object.assign(row, { result: JSON.parse(result), paymentGroupId, advancePaymentId });
        return 1;
      }),
    };
    prisma.tenantTransaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => {
      stage = { pays: [], advs: [], keys: [] };
      try {
        const out = await fn({ ...prisma, ...raw });
        ledger.pays.push(...stage.pays);
        ledger.advs.push(...stage.advs);
        ledger.keys.push(...stage.keys);
        return out;
      } finally {
        stage = null;
      }
    });
    (prisma as any).$rawSpy = raw;

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
    prisma.invoicePayment.findMany.mockImplementation(async (a: any) => {
      const ids: string[] | undefined = a?.where?.id?.in;
      return ids ? ledger.pays.filter((p) => ids.includes(p.id)) : [];
    });
    prisma.advancePayment.findFirst.mockImplementation(async (a: any) => {
      const row = ledger.advs.find((r) => r.id === a?.where?.id && r.tenantId === tenant);
      return row ? { balance: row.balance } : null;
    });
    const keyStore = {
      findFirst: jest.fn(async (a: any) => {
        const row = ledger.keys.find((k) => k.tenantId === tenant && k.key === a?.where?.key);
        return row ? { ...row } : null;
      }),
    };
    prisma.forTenant.mockImplementation(() => ({ ...prisma, paymentIdempotencyKey: keyStore }));
  }

  /** Payment rows / advances committed for the current tenant. */
  const committed = () => ({
    pays: ledger.pays.filter((p) => p.tenantId === tenant),
    advs: ledger.advs.filter((a) => a.tenantId === tenant),
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const commission = {
      syncInvoiceCommissionSafe: jest.fn(async () => {
        if (failAfterClaim) {
          failAfterClaim = false;
          throw new Error("injected failure after the claim");
        }
      }),
    };
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
        { provide: CommissionEngineService, useValue: commission },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
      ],
    }).compile();
    invoices = module.get(InvoicesService);
    customers = module.get(CustomersService);

    installLedger();
    prisma.paymentCounter.upsert.mockResolvedValue({ id: "tenant-a", next: 3 });
    prisma.invoice.findFirst.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: null,
      payments: [],
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      status: InvoiceStatus.SENT,
      total: 100,
      dueDate: null,
      payments: [],
    });
    prisma.invoice.update.mockResolvedValue({
      id: "inv-1",
      invoiceNumber: "INV-0001",
      customerId: "cust-1",
      total: 100,
      status: InvoiceStatus.PARTIAL,
      payments: [],
    });
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1" });
  });

  const standalone = (over: Record<string, unknown> = {}) =>
    ({
      customerId: "cust-1",
      totalAmount: 150,
      method: "CASH",
      reference: "receipt 7",
      paidAt: "2026-10-20",
      allocations: [{ invoiceId: "inv-1", amount: 100 }],
      ...over,
    }) as any;
  const keyed = (key: string, extra: Record<string, unknown> = {}) =>
    ({ actor: null, idempotencyKey: key, ...extra }) as any;

  describe("POST /invoices/payments/record (recordStandalonePayment)", () => {
    it("(a) two identical submits with the same key record ONE payment set; the second is replayed with the same paymentGroupId", async () => {
      const first: any = await invoices.recordStandalonePayment(standalone(), keyed("key-a"));
      const second: any = await invoices.recordStandalonePayment(standalone(), keyed("key-a"));

      const { pays, advs } = committed();
      expect({ payments: pays.length, advances: advs.length }).toEqual({
        payments: 1,
        advances: 1,
      });
      expect(second.replayed).toBe(true);
      expect(second.paymentGroupId).toBe(first.paymentGroupId);
      expect(second.payments.map((p: any) => p.id)).toEqual(first.payments.map((p: any) => p.id));
      expect(second.excess).toBe(50);
      expect(first.replayed).toBeUndefined();
      // The stored key row names the group and the excess advance.
      expect(ledger.keys).toHaveLength(1);
      expect(ledger.keys[0]).toMatchObject({
        scope: "STANDALONE_PAYMENT",
        paymentGroupId: first.paymentGroupId,
        advancePaymentId: advs[0].id,
      });
    });

    it("(c) the same key with a different amount is 409 IDEMPOTENCY_KEY_CONFLICT and writes nothing", async () => {
      await invoices.recordStandalonePayment(standalone(), keyed("key-c"));
      const before = committed();

      const err: any = await invoices
        .recordStandalonePayment(standalone({ totalAmount: 160 }), keyed("key-c"))
        .catch((e) => e);

      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: CONFLICT });
      expect(committed().pays).toHaveLength(before.pays.length);
      expect(committed().advs).toHaveLength(before.advs.length);
    });

    it("(c) the same key on a different writer (scope) is 409 IDEMPOTENCY_KEY_CONFLICT and writes nothing", async () => {
      await invoices.recordStandalonePayment(standalone(), keyed("key-scope"));
      const before = committed();

      // `as any`: master's createAdvancePayment takes no third argument (and ignores it).
      const err: any = await (customers as any)
        .createAdvancePayment(
          "cust-1",
          { amount: 150, method: "CASH", reference: "receipt 7" },
          { idempotencyKey: "key-scope" },
        )
        .catch((e: unknown) => e);

      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: CONFLICT });
      expect(committed()).toEqual(before);
    });

    it("(c) allocation order and sub-cent noise do not change the request: a reordered retry replays", async () => {
      prisma.invoice.findFirst.mockImplementation(async (a: any) => ({
        id: a.where.id,
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [],
      }));
      const allocs = [
        { invoiceId: "inv-1", amount: 40 },
        { invoiceId: "inv-2", amount: 60 },
      ];
      await invoices.recordStandalonePayment(
        standalone({ totalAmount: 100, allocations: allocs }),
        keyed("key-order"),
      );
      const again: any = await invoices.recordStandalonePayment(
        standalone({ totalAmount: 100.001, allocations: [...allocs].reverse() }),
        keyed("key-order"),
      );
      expect(again.replayed).toBe(true);
      expect(committed().pays).toHaveLength(2);
    });

    it("(d) a throw after the claim commits NO key; a retry with the same key then records exactly once", async () => {
      failAfterClaim = true;
      await expect(invoices.recordStandalonePayment(standalone(), keyed("key-d"))).rejects.toThrow(
        "injected failure after the claim",
      );
      expect({ keys: ledger.keys.length, ...committed() }).toEqual({
        keys: 0,
        pays: [],
        advs: [],
      });

      const retry: any = await invoices.recordStandalonePayment(standalone(), keyed("key-d"));
      expect(retry.replayed).toBeUndefined();
      expect(committed().pays).toHaveLength(1);
      expect(ledger.keys).toHaveLength(1);
    });

    it("(e) a replay after the payment was voided returns the stored result with the CURRENT status and writes nothing", async () => {
      const first: any = await invoices.recordStandalonePayment(standalone(), keyed("key-e"));
      ledger.pays[0].status = "VOID"; // the office voided it after the first response
      const writesBefore = prisma.invoicePayment.create.mock.calls.length;
      const raw = (prisma as any).$rawSpy;
      const claimsBefore = raw.$queryRaw.mock.calls.length;
      const settlesBefore = raw.$executeRaw.mock.calls.length;

      const replay: any = await invoices.recordStandalonePayment(standalone(), keyed("key-e"));

      expect(replay.replayed).toBe(true);
      expect(replay.paymentGroupId).toBe(first.paymentGroupId);
      expect(replay.payments[0].status).toBe("VOID");
      expect(first.payments[0].status).toBe("PAID");
      expect(prisma.invoicePayment.create.mock.calls.length).toBe(writesBefore);
      expect(raw.$queryRaw.mock.calls.length).toBe(claimsBefore);
      expect(raw.$executeRaw.mock.calls.length).toBe(settlesBefore);
    });

    it("(b, unit) a claim lost to a duplicate that committed after the pre-read replays the winner and writes no money", async () => {
      const winner: any = await invoices.recordStandalonePayment(standalone(), keyed("key-race"));
      const keyStore = prisma.forTenant().paymentIdempotencyKey;
      keyStore.findFirst.mockResolvedValueOnce(null); // the pre-read ran before the winner committed
      const writesBefore = prisma.invoicePayment.create.mock.calls.length;

      const loser: any = await invoices.recordStandalonePayment(standalone(), keyed("key-race"));

      expect(loser.replayed).toBe(true);
      expect(loser.paymentGroupId).toBe(winner.paymentGroupId);
      expect(prisma.invoicePayment.create.mock.calls.length).toBe(writesBefore);
      expect(committed().pays).toHaveLength(1);
    });

    it("(f) no key: behaviour is identical to today (no claim, no key row, the same response shape)", async () => {
      const a: any = await invoices.recordStandalonePayment(standalone(), { actor: null });
      const b: any = await invoices.recordStandalonePayment(standalone(), { actor: null });

      expect(committed().pays).toHaveLength(2);
      expect(ledger.keys).toHaveLength(0);
      const raw = (prisma as any).$rawSpy;
      const claims = raw.$queryRaw.mock.calls.filter(([s]: any[]) =>
        sqlOf(s).includes("PaymentIdempotencyKey"),
      );
      expect(claims).toHaveLength(0);
      expect(Object.keys(a).sort()).toEqual(["excess", "paymentGroupId", "payments"]);
      expect(b.paymentGroupId).not.toBe(a.paymentGroupId);
    });

    it("(g) the same key in two tenants gives two independent payments", async () => {
      tenant = "tenant-a";
      const a: any = await invoices.recordStandalonePayment(standalone(), keyed("shared-key"));
      tenant = "tenant-b";
      const b: any = await invoices.recordStandalonePayment(standalone(), keyed("shared-key"));

      expect(b.replayed).toBeUndefined();
      expect(b.paymentGroupId).not.toBe(a.paymentGroupId);
      expect(ledger.pays.filter((p) => p.tenantId === "tenant-a")).toHaveLength(1);
      expect(ledger.pays.filter((p) => p.tenantId === "tenant-b")).toHaveLength(1);
      expect(ledger.keys.map((k) => k.tenantId).sort()).toEqual(["tenant-a", "tenant-b"]);
    });
  });

  describe("POST /invoices/:id/payments (recordPayment)", () => {
    const dto = (amount = 40) => ({ amount, method: "CASH", reference: "chq 1" }) as any;

    it("(a) two identical submits with the same key record ONE payment; the second is replayed", async () => {
      const first: any = await invoices.recordPayment("inv-1", dto(), keyed("inv-key"));
      const second: any = await invoices.recordPayment("inv-1", dto(), keyed("inv-key"));

      expect(committed().pays).toHaveLength(1);
      expect(second.replayed).toBe(true);
      expect(second.createdPaymentId).toBe(first.createdPaymentId);
    });

    it("(c) the same key with a different amount is 409 IDEMPOTENCY_KEY_CONFLICT and writes nothing", async () => {
      await invoices.recordPayment("inv-1", dto(40), keyed("inv-key-c"));
      const err: any = await invoices
        .recordPayment("inv-1", dto(41), keyed("inv-key-c"))
        .catch((e) => e);
      expect(err?.getStatus?.()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: CONFLICT });
      expect(committed().pays).toHaveLength(1);
    });

    it("(f) no key: two calls record two payments, as today", async () => {
      await invoices.recordPayment("inv-1", dto());
      await invoices.recordPayment("inv-1", dto());
      expect(committed().pays).toHaveLength(2);
      expect(ledger.keys).toHaveLength(0);
    });
  });

  describe("POST /customers/:id/advance-payments (createAdvancePayment)", () => {
    const dto = (amount = 75) => ({ amount, method: "CASH", reference: "adv 1" });
    const call = (amount: number, key?: string) =>
      key
        ? (customers as any).createAdvancePayment("cust-1", dto(amount), { idempotencyKey: key })
        : customers.createAdvancePayment("cust-1", dto(amount));

    it("(a) two identical submits with the same key record ONE advance; the second is replayed with its current balance", async () => {
      const first: any = await call(75, "adv-key");
      ledger.advs[0].balance = 25; // 50 of it was applied since
      const second: any = await call(75, "adv-key");

      expect(committed().advs).toHaveLength(1);
      expect(second.replayed).toBe(true);
      expect(second.id).toBe(first.id);
      expect(second.balance).toBe(25);
      expect(ledger.keys[0]).toMatchObject({
        scope: "ADVANCE_PAYMENT",
        advancePaymentId: first.id,
      });
    });

    it("(c) the same key with a different amount is 409 and writes nothing", async () => {
      await call(75, "adv-key-c");
      const err: any = await call(80, "adv-key-c").catch((e: unknown) => e);
      expect(err?.getStatus?.()).toBe(409);
      expect(committed().advs).toHaveLength(1);
    });

    it("(f) no key: two calls record two advances, as today", async () => {
      await call(75);
      await call(75);
      expect(committed().advs).toHaveLength(2);
      expect(ledger.keys).toHaveLength(0);
    });
  });
});
