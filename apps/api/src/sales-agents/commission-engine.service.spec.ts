import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CommissionEngineService } from "./commission-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { AuditService } from "../audit/audit.service";
import { NSF_FEE_DESCRIPTION_PREFIX } from "./commission-math";

/**
 * The sales-agents models (SalesAgent, CommissionAccrual, ...) are not in
 * testing/prisma-mock.ts's fixed model list, and that file is outside this
 * work package's file allowlist (same constraint noted in
 * sales-agents.service.spec.ts). Rather than extending createMockPrisma(),
 * every engine method under test here accepts an explicit `db` parameter —
 * passing one bypasses `this.prisma.tenantTransaction` entirely, so a
 * hand-rolled fake db drives the sync algorithm deterministically without
 * needing the shared mock at all.
 */
function buildFakeDb(opts: {
  invoice: any;
  assignment?: any;
  customerRates?: any[];
  agentRates?: any[];
  agent?: any;
}) {
  const calls = {
    creates: [] as any[],
    updates: [] as any[],
    deletes: [] as any[],
    adjustments: [] as any[],
  };
  const db: any = {
    // B73 lock seam (runSync's `FOR UPDATE` on CommissionAccrual, keyed on invoiceId only).
    // Every existing engine test needs this present once the fix calls it unconditionally;
    // REG-B73 T5 below overrides it with a stateful mock to prove the lock's ordering.
    $executeRaw: jest.fn().mockResolvedValue(0),
    invoice: { findUnique: jest.fn().mockResolvedValue(opts.invoice) },
    agentAssignment: { findFirst: jest.fn().mockResolvedValue(opts.assignment ?? null) },
    customerCommissionRate: { findMany: jest.fn().mockResolvedValue(opts.customerRates ?? []) },
    salesAgentRate: { findMany: jest.fn().mockResolvedValue(opts.agentRates ?? []) },
    // Defaults to an ACTIVE, non-deleted agent so "creates a new row" tests
    // don't have to restate the lifecycle gate every time; override `opts.agent`
    // to exercise PAUSED / STOPPED_FOR_NEW / soft-deleted specifically.
    salesAgent: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          opts.agent ?? { status: "ACTIVE", deletedAt: null, stopNewBusinessAt: null },
        ),
    },
    commissionAccrual: {
      create: jest.fn().mockImplementation((args: any) => {
        const row = { id: `accrual-${calls.creates.length + 1}`, claimedAmount: 0, ...args.data };
        calls.creates.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation((args: any) => {
        calls.updates.push(args);
        return Promise.resolve({ id: args.where.id, ...args.data });
      }),
      delete: jest.fn().mockImplementation((args: any) => {
        calls.deletes.push(args.where.id);
        return Promise.resolve({});
      }),
      // The pre-insert double-accrual check in createAccrualRow; null = the
      // row really is new (a concurrent sync committing one mid-flight is the
      // only case that returns a row here).
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    commissionAdjustment: {
      create: jest.fn().mockImplementation((args: any) => {
        const row = { id: `adj-${calls.adjustments.length + 1}`, line: null, ...args.data };
        calls.adjustments.push(row);
        return Promise.resolve(row);
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  return { db, calls };
}

function baseInvoice(overrides: any = {}) {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    customerId: "cust-1",
    status: "SENT",
    subtotal: 1000,
    discount: 0,
    total: 1000,
    issueDate: new Date("2026-06-01T00:00:00.000Z"),
    order: null,
    recurringInvoice: null,
    payments: [],
    items: [],
    commissionAccruals: [],
    ...overrides,
  };
}

describe("CommissionEngineService", () => {
  let service: CommissionEngineService;
  let prisma: { getTenantId: jest.Mock; tenantTransaction: jest.Mock; forTenant: jest.Mock };
  let entitlements: { hasFlag: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = {
      getTenantId: jest.fn().mockReturnValue("tenant-1"),
      tenantTransaction: jest.fn(),
      forTenant: jest.fn(),
    };
    entitlements = { hasFlag: jest.fn().mockResolvedValue(true) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        CommissionEngineService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(CommissionEngineService);
  });

  describe("flag / tenant gating", () => {
    it("flag OFF writes nothing and never touches the database (PIN T6: the B73 lock is never taken either — the early return precedes it)", async () => {
      entitlements.hasFlag.mockResolvedValue(false);
      const { db } = buildFakeDb({ invoice: baseInvoice() });
      await service.syncInvoiceCommission("inv-1", db);
      expect(db.invoice.findUnique).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it("no tenant context (SUPER_ADMIN) writes nothing and never checks the flag", async () => {
      prisma.getTenantId.mockReturnValue(null);
      const { db } = buildFakeDb({ invoice: baseInvoice() });
      await service.syncInvoiceCommission("inv-1", db);
      expect(db.invoice.findUnique).not.toHaveBeenCalled();
      expect(entitlements.hasFlag).not.toHaveBeenCalled();
    });

    it("syncInvoiceCommissionSafe swallows a thrown error and never rejects", async () => {
      const { db } = buildFakeDb({ invoice: baseInvoice() });
      db.invoice.findUnique.mockRejectedValue(new Error("boom"));
      await expect(service.syncInvoiceCommissionSafe("inv-1", db)).resolves.toBeUndefined();
    });
  });

  describe("syncInvoiceCommission — creation and idempotency", () => {
    it("creates a new accrual row on first sync, to the cent, and a second sync with the same state writes nothing", async () => {
      const invoice = baseInvoice({
        payments: [{ id: "p1", amount: 250, method: "CASH", status: "PAID" }],
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];

      const first = buildFakeDb({ invoice, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", first.db);

      expect(first.calls.creates).toHaveLength(1);
      const created = first.calls.creates[0];
      // base = 1000 (no discount, tax/shipping excluded), accrued = 10% = 100,
      // ratio = 250 / 1000 = 0.25 -> payable = 25.00, exactly to the cent.
      expect(created.baseAmount).toBe(1000);
      expect(created.accruedAmount).toBe(100);
      expect(created.payableAmount).toBe(25);
      expect(created.status).toBe("PARTIAL");
      expect(first.calls.adjustments).toHaveLength(0);

      // Second sync: the invoice now carries the just-created row back with
      // identical inputs -> nothing should change (idempotency).
      const invoiceRound2 = baseInvoice({
        payments: invoice.payments,
        commissionAccruals: [{ ...created, adjustments: [] }],
      });
      const second = buildFakeDb({ invoice: invoiceRound2, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", second.db);

      expect(second.calls.creates).toHaveLength(0);
      expect(second.db.commissionAccrual.update).not.toHaveBeenCalled();
      expect(second.calls.adjustments).toHaveLength(0);
    });

    it("keeps the rateSource NONE placeholder row across syncs, and the second sync writes nothing", async () => {
      // Attributed customer, but no order override, no customer rate and no
      // agent rate -> rateSource NONE. The plan requires that zero-amount row
      // to SURVIVE so a later backdated rate has something the recompute sweep
      // can find and correct in place.
      const assignment = { agentId: "agent-1" };
      const first = buildFakeDb({ invoice: baseInvoice(), assignment });
      await service.syncInvoiceCommission("inv-1", first.db);

      expect(first.calls.creates).toHaveLength(1);
      const created = first.calls.creates[0];
      expect(created.rateSource).toBe("NONE");
      expect(created.ratePct).toBe(0);
      expect(created.accruedAmount).toBe(0);

      const invoiceRound2 = baseInvoice({ commissionAccruals: [{ ...created, adjustments: [] }] });
      const second = buildFakeDb({ invoice: invoiceRound2, assignment });
      await service.syncInvoiceCommission("inv-1", second.db);

      expect(second.calls.creates).toHaveLength(0);
      expect(second.db.commissionAccrual.delete).not.toHaveBeenCalled();
      expect(second.db.commissionAccrual.update).not.toHaveBeenCalled();
    });

    it("a PAUSED agent blocks creation of a brand-new row", async () => {
      const invoice = baseInvoice({
        payments: [{ id: "p1", amount: 500, method: "CASH", status: "PAID" }],
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];
      const { db, calls } = buildFakeDb({
        invoice,
        assignment,
        agentRates,
        agent: { status: "PAUSED", deletedAt: null, stopNewBusinessAt: null },
      });
      await service.syncInvoiceCommission("inv-1", db);
      expect(calls.creates).toHaveLength(0);
    });
  });

  describe("pro-rata release and write-off — to the cent", () => {
    it("payable releases pro-rata as cash lands (20% collected -> exactly 20% of accrued)", async () => {
      const invoice = baseInvoice({
        subtotal: 840,
        discount: 40, // base = 800
        total: 900, // tax/shipping folded in here, excluded from base
        payments: [{ id: "p1", amount: 180, method: "ACH", status: "PAID" }], // 20% of 900
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 12.5, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];
      const { db } = buildFakeDb({ invoice, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", db);

      const created = db.commissionAccrual.create.mock.calls[0][0].data;
      // base = 800, accrued = 800 x 12.5% = 100.00, ratio = 180/900 = 0.20
      // -> payable = 100 x 0.20 = 20.00 exactly, not the full 100.
      expect(created.baseAmount).toBe(800);
      expect(created.accruedAmount).toBe(100);
      expect(created.payableAmount).toBe(20);
      expect(created.status).toBe("PARTIAL");
    });

    it("a WRITTEN_OFF invoice still counts as issued -- payable stops at exactly what was collected, never the uncollected remainder", async () => {
      const invoice = baseInvoice({
        status: "WRITTEN_OFF",
        subtotal: 1000,
        discount: 0,
        total: 1000,
        payments: [{ id: "p1", amount: 300, method: "CASH", status: "PAID" }],
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];
      const { db } = buildFakeDb({ invoice, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", db);

      const created = db.commissionAccrual.create.mock.calls[0][0].data;
      // accrued = 100 (10% of the full $1000 base -- earned at issue); ratio
      // = 300/1000 = 0.30 -> payable = 30.00. The uncollected $700 (written
      // off) never becomes payable -- no commission on bad debt.
      expect(created.accruedAmount).toBe(100);
      expect(created.payableAmount).toBe(30);
      expect(created.status).toBe("PARTIAL");

      // A later sync with no new cash must NOT move payable on its own -- the
      // only way the remaining $70 ever releases is an actual recovery payment.
      const unpaidRow = { ...created, id: "accrual-1", adjustments: [] };
      const invoiceRound2 = baseInvoice({ ...invoice, commissionAccruals: [unpaidRow] });
      const { db: db2 } = buildFakeDb({ invoice: invoiceRound2, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", db2);
      expect(db2.commissionAccrual.update).not.toHaveBeenCalled();
      expect(db2.commissionAdjustment.create).not.toHaveBeenCalled();
    });
  });

  describe("NSF fee exclusion from the commission base", () => {
    it("the state builder fills nsfFees from only the NSF-prefixed item, leaving a normal line out of it", async () => {
      // $1000 goods + a $25 NSF bounce fee folded into the stored subtotal/total
      // by invoices.service.ts setCheckStatus, fully repaid.
      const invoice = baseInvoice({
        subtotal: 1025,
        total: 1025,
        items: [
          { description: `${NSF_FEE_DESCRIPTION_PREFIX} CHK-1001`, qty: 1, unitPrice: 25 },
          { description: "Widget line", qty: 2, unitPrice: 10 },
        ],
        payments: [{ id: "p1", amount: 1025, method: "CASH", status: "PAID" }],
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];
      const { db } = buildFakeDb({ invoice, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", db);

      const created = db.commissionAccrual.create.mock.calls[0][0].data;
      // base = subtotal(1025) - discount(0) - nsfFees(25) = 1000, so the $25 fee
      // never inflates the base; accrued = 10% of 1000 = 100.00, not 102.50.
      expect(created.baseAmount).toBe(1000);
      expect(created.accruedAmount).toBe(100);
      expect(created.payableAmount).toBe(100);
    });
  });

  describe("reassignment", () => {
    it("zero-targets the old agent's row and emits exactly one REASSIGNMENT adjustment for what was already claimed", async () => {
      const oldRow = {
        id: "accrual-old",
        agentId: "agent-A",
        basisDate: new Date("2026-06-01T00:00:00.000Z"),
        baseAmount: 1000,
        ratePct: 10,
        rateSource: "AGENT_DEFAULT",
        accruedAmount: 100,
        payableAmount: 100,
        claimedAmount: 60,
        status: "PAYABLE",
        adjustments: [],
      };
      const invoice = baseInvoice({
        payments: [{ id: "p1", amount: 1000, method: "CASH", status: "PAID" }],
        commissionAccruals: [oldRow],
      });
      // Customer is now attributed to a different agent.
      const assignment = { agentId: "agent-B" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];
      const { db, calls } = buildFakeDb({ invoice, assignment, agentRates });

      await service.syncInvoiceCommission("inv-1", db);

      expect(db.commissionAccrual.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "accrual-old" },
          data: expect.objectContaining({ payableAmount: 0, accruedAmount: 0 }),
        }),
      );
      expect(calls.adjustments).toHaveLength(1);
      expect(calls.adjustments[0]).toEqual(
        expect.objectContaining({
          accrualId: "accrual-old",
          agentId: "agent-A",
          kind: "REASSIGNMENT",
          amount: -60,
        }),
      );
      // The newly-attributed agent gets a fresh row of their own.
      expect(calls.creates).toHaveLength(1);
      expect(calls.creates[0].agentId).toBe("agent-B");
    });
  });

  describe("drift emission", () => {
    it("a negative drift emits exactly one CLAWBACK adjustment, and re-running with the converged state emits none", async () => {
      const existingRow = {
        id: "accrual-1",
        agentId: "agent-1",
        basisDate: new Date("2026-06-01T00:00:00.000Z"),
        baseAmount: 1000,
        ratePct: 10,
        rateSource: "AGENT_DEFAULT",
        accruedAmount: 100,
        payableAmount: 100,
        claimedAmount: 100, // fully claimed via a statement at the old (full) payable
        status: "SETTLED",
        adjustments: [],
      };
      // The invoice was subsequently credited/reversed -- cash collected now
      // covers only 60% of the total, so payable should drop to 60.
      const invoice = baseInvoice({
        payments: [{ id: "p1", amount: 600, method: "CASH", status: "PAID" }],
        commissionAccruals: [existingRow],
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];

      const first = buildFakeDb({ invoice, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", first.db);

      expect(first.calls.adjustments).toHaveLength(1);
      expect(first.calls.adjustments[0]).toEqual(
        expect.objectContaining({ accrualId: "accrual-1", kind: "CLAWBACK", amount: -40 }),
      );
      const updateCall = first.db.commissionAccrual.update.mock.calls.find(
        (c: any) => c[0].where.id === "accrual-1",
      );
      expect(updateCall[0].data.payableAmount).toBe(60);

      // Re-run with the post-adjustment state: drift is now exactly 0 -> no
      // second adjustment gets emitted.
      const invoiceRound2 = baseInvoice({
        payments: invoice.payments,
        commissionAccruals: [{ ...existingRow, payableAmount: 60, adjustments: [{ amount: -40 }] }],
      });
      const second = buildFakeDb({ invoice: invoiceRound2, assignment, agentRates });
      await service.syncInvoiceCommission("inv-1", second.db);
      expect(second.calls.adjustments).toHaveLength(0);
    });

    it("REG-B73 T5 concurrent sync appends one CLAWBACK, not two, once the runSync lock serializes the read", async () => {
      // Simulates the B73 race: a SECOND writer commits its own -40 CLAWBACK for this
      // accrual the instant it acquires the `FOR UPDATE` lock. If runSync takes the lock
      // BEFORE reading the invoice, it will see that committed adjustment and — since the
      // drift is already fully accounted for — append nothing further. Today, with no
      // lock at all, the read races ahead of the "other" writer's commit and reads an
      // empty adjustments array, so runSync appends its OWN -40 CLAWBACK — a duplicate.
      const committedByOther: Array<{ amount: number }> = [];
      const callOrder: string[] = [];
      const existingRow = {
        id: "accrual-1",
        agentId: "agent-1",
        basisDate: new Date("2026-06-01T00:00:00.000Z"),
        baseAmount: 1000,
        ratePct: 10,
        rateSource: "AGENT_DEFAULT",
        accruedAmount: 100,
        payableAmount: 100,
        claimedAmount: 100, // accrual claimed 100
        status: "SETTLED",
      };
      const invoice = baseInvoice({
        payments: [{ id: "p1", amount: 600, method: "CASH", status: "PAID" }], // ratio 0.6 -> payable 60
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];
      const { db, calls } = buildFakeDb({ invoice, assignment, agentRates });

      // Acquiring the lock is the moment the "other" writer's CLAWBACK becomes visible.
      db.$executeRaw = jest.fn(async (..._args: any[]) => {
        callOrder.push("lock");
        committedByOther.push({ amount: -40 });
        return 0;
      });
      // Reads the CURRENT state of committedByOther — i.e. whatever has landed by the
      // time this read actually runs, not a snapshot taken up front.
      db.invoice.findUnique.mockImplementation(async () => {
        callOrder.push("read");
        return {
          ...invoice,
          commissionAccruals: [{ ...existingRow, adjustments: [...committedByOther] }],
        };
      });

      await service.syncInvoiceCommission("inv-1", db);

      // The lock made our own read see the other writer's -40 already applied, so the
      // drift is fully accounted for and runSync appends NOTHING further.
      expect(calls.adjustments).toHaveLength(0);
      expect(callOrder.indexOf("lock")).toBeGreaterThanOrEqual(0);
      expect(callOrder.indexOf("lock")).toBeLessThan(callOrder.indexOf("read"));

      const [strings, ...values] = db.$executeRaw.mock.calls[0];
      const sql = (strings as TemplateStringsArray).join("");
      expect(sql).toContain('FROM "CommissionAccrual"');
      expect(sql).toContain('"invoiceId" =');
      expect(sql).toContain("FOR UPDATE");
      expect(values).toEqual(["inv-1"]);
    });

    it("REG-B73 T5b a NON-transactional client is wrapped in a tenantTransaction, so the lock is never taken on an autocommit connection", async () => {
      // The un-`tx`'d reconcileOrderDraftInvoice hook path (orders -> invoices ->
      // syncInvoiceCommissionSafe) hands the engine a `forTenant()` client. A
      // `FOR UPDATE` issued on that client commits with its own statement and
      // releases the row before the invoice read, so the B73 race stays open. The
      // sync must therefore run inside its OWN transaction instead.
      const plain = buildFakeDb({ invoice: baseInvoice() });
      const tx = buildFakeDb({ invoice: baseInvoice() });
      // A base / `$extends`ed client exposes `$transaction`; a Prisma tx client does not.
      plain.db.$transaction = jest.fn();
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx.db));

      await service.syncInvoiceCommission("inv-1", plain.db);

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(tx.db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.db.invoice.findUnique).toHaveBeenCalledTimes(1);
      expect(plain.db.$executeRaw).not.toHaveBeenCalled();
      expect(plain.db.invoice.findUnique).not.toHaveBeenCalled();
    });

    it("REG-B73 T5b a transaction client is used as-is — no nested transaction is opened", async () => {
      const { db } = buildFakeDb({ invoice: baseInvoice() }); // no `$transaction` => tx client

      await service.syncInvoiceCommission("inv-1", db);

      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.invoice.findUnique).toHaveBeenCalledTimes(1);
    });

    it("voiding an invoice with claimed commission emits a CLAWBACK, not a RATE_CHANGE", async () => {
      // Un-issuing forces the target rate to 0 / NONE. That is a consequence of
      // the void, not a retroactive rate change -- the adjustment taxonomy the
      // statements read must say CLAWBACK.
      const claimedRow = {
        id: "accrual-1",
        agentId: "agent-1",
        basisDate: new Date("2026-06-01T00:00:00.000Z"),
        baseAmount: 1000,
        ratePct: 10,
        rateSource: "AGENT_DEFAULT",
        accruedAmount: 100,
        payableAmount: 100,
        claimedAmount: 100, // claimed on an approved statement
        status: "SETTLED",
        adjustments: [],
      };
      const invoice = baseInvoice({
        status: "VOID",
        payments: [{ id: "p1", amount: 1000, method: "CASH", status: "PAID" }],
        commissionAccruals: [claimedRow],
      });
      const assignment = { agentId: "agent-1" };
      const agentRates = [{ ratePct: 10, effectiveFrom: new Date("2026-01-01T00:00:00.000Z") }];
      const { db, calls } = buildFakeDb({ invoice, assignment, agentRates });

      await service.syncInvoiceCommission("inv-1", db);

      expect(calls.adjustments).toHaveLength(1);
      expect(calls.adjustments[0]).toEqual(
        expect.objectContaining({ accrualId: "accrual-1", kind: "CLAWBACK", amount: -100 }),
      );
      expect(db.commissionAccrual.delete).not.toHaveBeenCalled();
    });
  });

  describe("removeInvoiceCommission", () => {
    it("throws ConflictException when any accrual has claimedAmount > 0, and touches nothing", async () => {
      const { db } = buildFakeDb({ invoice: baseInvoice() });
      db.commissionAccrual.findMany.mockResolvedValue([
        { id: "accrual-1", claimedAmount: 25, adjustments: [] },
      ]);
      await expect(service.removeInvoiceCommission("inv-1", db)).rejects.toThrow(ConflictException);
      expect(db.commissionAccrual.deleteMany).not.toHaveBeenCalled();
    });

    it("deletes unclaimed accruals and their unswept adjustments, but preserves swept ones", async () => {
      const { db } = buildFakeDb({ invoice: baseInvoice() });
      db.commissionAccrual.findMany.mockResolvedValue([
        {
          id: "accrual-1",
          claimedAmount: 0,
          adjustments: [
            { id: "adj-swept", line: { id: "line-1" } },
            { id: "adj-unswept", line: null },
          ],
        },
      ]);
      await service.removeInvoiceCommission("inv-1", db);
      expect(db.commissionAdjustment.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["adj-unswept"] } },
      });
      expect(db.commissionAccrual.deleteMany).toHaveBeenCalledWith({
        where: { invoiceId: "inv-1" },
      });
    });
  });

  describe("recomputeCommissionRange", () => {
    it("flag OFF returns zero without querying invoices", async () => {
      entitlements.hasFlag.mockResolvedValue(false);
      const invoiceFindMany = jest.fn();
      prisma.forTenant.mockReturnValue({ invoice: { findMany: invoiceFindMany } });
      const result = await service.recomputeCommissionRange({ agentId: "agent-1" }, new Date());
      expect(result).toEqual({ invoicesSynced: 0 });
      expect(invoiceFindMany).not.toHaveBeenCalled();
    });

    it("syncs each candidate invoice in its own transaction and audit-logs the sweep", async () => {
      prisma.forTenant.mockReturnValue({
        invoice: { findMany: jest.fn().mockResolvedValue([{ id: "inv-1" }, { id: "inv-2" }]) },
      });
      const { db } = buildFakeDb({ invoice: null }); // invoice.findUnique -> null -> no-op sync
      prisma.tenantTransaction.mockImplementation((fn: any) => fn(db));

      const fromDate = new Date("2026-01-01T00:00:00.000Z");
      const result = await service.recomputeCommissionRange({ agentId: "agent-1" }, fromDate);

      expect(result).toEqual({ invoicesSynced: 2 });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "commission.recompute",
          meta: expect.objectContaining({ scope: { agentId: "agent-1" }, count: 2 }),
        }),
      );
    });
  });
});
