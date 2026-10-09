// OrdersService / InvoicesService pull ESM-only modules (@react-pdf/renderer, expo-server-sdk)
// Jest's CommonJS parser cannot load; this spec drives them through mocks at the module boundary.
jest.mock("../orders.service", () => ({ OrdersService: class OrdersService {} }));
jest.mock("../../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));

// The shared Postgres advisory lock is replaced by a per-key in-process mutex with the same contract
// (fn never runs without the lock; same key serialises, different keys do not), so a spec can
// interleave two calls and prove the section is actually serialised.
const mockLocks = new Map<string, Promise<unknown>>();
const mockLockCalls: Array<{ family: string; key: string; mode: string }> = [];
const mockLockFailure: { error: Error | null } = { error: null };
jest.mock("../../common/db-locks", () => ({
  ...jest.requireActual("../../common/db-locks"),
  withAdvisoryLock: async (opts: any, fn: () => Promise<unknown>) => {
    mockLockCalls.push({ family: opts.family, key: opts.key, mode: opts.mode });
    if (mockLockFailure.error) throw mockLockFailure.error;
    const prev = mockLocks.get(opts.key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    mockLocks.set(
      opts.key,
      prev.then(() => mine),
    );
    await prev;
    try {
      return { acquired: true, value: await fn() };
    } finally {
      release();
    }
  },
}));

import { ConflictException, BadRequestException, NotFoundException } from "@nestjs/common";
import { LockTimeoutError, LockUnavailableError } from "../../common/db-locks";
import { Test } from "@nestjs/testing";
import { CounterSaleService } from "./counter-sale.service";
import { WalkInCustomerService } from "./walk-in-customer";
import { FULFILMENT_CAPABILITY_READER } from "./fulfilment-capability-reader";
import type { FulfilmentCapability } from "@routeflow/types";
import { OrdersService } from "../orders.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import { legGroupId } from "./counter-sale-tender";

/**
 * POST /orders/counter-sale orchestration (SA-655, item C step 2). Every collaborator is a mock:
 * `createSale` (the prod-proven create -> DELIVERED -> invoice -> send) and `recordPayment` are
 * spies, so the spec proves WHAT the counter-sale layer hands them and in what order. The money
 * itself (line math, tax, totals) stays in create()/@routeflow/pricing; no number is derived here
 * except the payment split and the change.
 *
 * (f) Staff oversell is allowed by policy (oversell-policy.ts: resolveOversellAllowed is true for
 * OPERATOR/TENANT_ADMIN), so there is deliberately NO staff stock-refusal case: the stock is
 * decremented once, inside create(), and this layer touches no stock.
 */

// The exact #3188 deriveFulfilmentCapability shape.
const cap = (counter: "always" | "optional" | "off", over: Partial<FulfilmentCapability> = {}) =>
  ({
    methods: counter === "always" ? ["PICKUP", "SHIP"] : ["ROUTE", "SHIP"],
    staffDefault: counter === "always" ? "PICKUP" : "ROUTE",
    staffOpensAs: counter === "always" ? "counter" : "order",
    portalMethods: [],
    portalDefault: null,
    counter,
    fleet: true,
    consistent: true,
    ...over,
  }) as FulfilmentCapability;

const staff = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const item = { productId: "p1", qty: 2, unitPrice: 5 };
// Every leg-0 payment row is written with the sale's server-built group id, in the same create.
const LEG0 = { paymentGroupId: legGroupId("ord-1", 0) };

type Inv = { id: string; total: number; status: string; createdAt: Date; payments: any[] };

describe("CounterSaleService.ring", () => {
  let service: CounterSaleService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let createSale: jest.Mock;
  let findReplayCandidateByKey: jest.Mock;
  let recordPayment: jest.Mock;
  let walkIn: { getOrCreateWalkIn: jest.Mock };
  let audit: { log: jest.Mock };
  let reader: { get: jest.Mock };
  let invoices: Inv[];
  let replay: boolean;
  let replayOrder: { id: string; counterSale?: boolean };

  const inv = (id: string, total: number, payments: any[] = [], at = 1): Inv => ({
    id,
    total,
    status: "SENT",
    createdAt: new Date(2026, 9, 4, 12, 0, at),
    payments,
  });
  const errorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as any;
    }
    throw new Error("expected a rejection");
  };
  const codeOf = async (p: Promise<unknown>) => (await errorOf(p)).getResponse().code;

  beforeEach(async () => {
    mockLocks.clear();
    mockLockCalls.length = 0;
    mockLockFailure.error = null;
    prisma = createMockPrisma();
    invoices = [inv("inv-1", 37.25)];
    replay = false;
    replayOrder = { id: "ord-1", counterSale: true };
    createSale = jest.fn(async (_dto: any, _u: any, sale: any) => {
      if (replay) sale?.onReplay?.(replayOrder);
      return { id: "inv-1", orderId: "ord-1", invoiceNumber: "INV-1" };
    });
    findReplayCandidateByKey = jest.fn(async () => null);
    recordPayment = jest.fn(async (invoiceId: string, dto: any) => {
      const target = invoices.find((i) => i.id === invoiceId)!;
      if (target.payments.some((p) => p.status !== "VOID" && p.method !== "CREDIT_NOTE"))
        throw new BadRequestException("Invoice is already fully paid");
      target.payments.push({
        id: `pay-${invoiceId}`,
        amount: dto.amount,
        method: dto.method,
        status: "PAID",
      });
      return { id: invoiceId, createdPaymentId: `pay-${invoiceId}` };
    });
    walkIn = { getOrCreateWalkIn: jest.fn().mockResolvedValue("cust-walkin") };
    reader = { get: jest.fn().mockResolvedValue(cap("optional")) };
    audit = { log: jest.fn().mockResolvedValue(undefined) };

    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    // SA-436: the tenant's send-time sweep switch. ON here so the open-credit guard specs mean something;
    // the OFF case is pinned on its own below.
    prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: true });
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1" });
    prisma.invoice.findMany.mockImplementation(async ({ where }: any = {}) =>
      invoices
        .filter((i) => !where?.status?.notIn?.includes(i.status))
        .map((i) => ({ ...i, payments: [...i.payments], invoiceNumber: `N-${i.id}` })),
    );

    const mod = await Test.createTestingModule({
      providers: [
        CounterSaleService,
        { provide: OrdersService, useValue: { createSale, findReplayCandidateByKey } },
        { provide: InvoicesService, useValue: { recordPayment } },
        { provide: WalkInCustomerService, useValue: walkIn },
        { provide: PrismaService, useValue: prisma },
        { provide: FULFILMENT_CAPABILITY_READER, useValue: reader },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(CounterSaleService);
  });

  const named = (payment: any, extra: any = {}) => ({
    customerId: "cust-1",
    items: [item],
    payment,
    ...extra,
  });

  // ── 1. gate ───────────────────────────────────────────────────────────────
  describe("gate", () => {
    it("counter off: 403 COUNTER_SALES_DISABLED and NOTHING is written or called", async () => {
      reader.get.mockResolvedValue(cap("off"));
      const e = await errorOf(service.ring(named({ method: "CASH" }) as never, staff));
      expect(e.getStatus()).toBe(403);
      expect(e.getResponse().code).toBe("COUNTER_SALES_DISABLED");
      // Approved copy: the switch is back-office controlled, so it never points users to settings.
      expect(e.getResponse().message).toBe("Counter sales are not turned on for this business.");
      expect(createSale).not.toHaveBeenCalled();
      expect(recordPayment).not.toHaveBeenCalled();
      expect(walkIn.getOrCreateWalkIn).not.toHaveBeenCalled();
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it("walk-in sale on a tenant with the counter off creates no walk-in customer", async () => {
      reader.get.mockResolvedValue(cap("off"));
      await expect(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      ).rejects.toMatchObject({ status: 403 });
      expect(walkIn.getOrCreateWalkIn).not.toHaveBeenCalled();
    });

    it.each(["always", "optional"] as const)("counter %s is allowed", async (counter) => {
      reader.get.mockResolvedValue(cap(counter));
      await expect(service.ring(named({ method: "CASH" }) as never, staff)).resolves.toBeDefined();
      expect(reader.get).toHaveBeenCalledWith("test-tenant");
    });

    it("the counter POST marks the order as a counter sale (SA-672e: counterSale: true into createSale)", async () => {
      await service.ring(named({ method: "CASH" }) as never, staff);
      expect(createSale).toHaveBeenCalledWith(
        expect.anything(),
        staff,
        expect.objectContaining({ counterSale: true }),
      );
    });

    it("a walk-in counter POST also marks the order as a counter sale", async () => {
      await service.ring(
        { walkIn: true, items: [item], payment: { method: "CASH" } } as never,
        staff,
      );
      expect(createSale).toHaveBeenCalledWith(
        expect.anything(),
        staff,
        expect.objectContaining({ counterSale: true }),
      );
    });

    it("a key that belongs to a NON-counter order is 409 COUNTER_SALE_KEY_CONFLICT before any write", async () => {
      replay = true;
      replayOrder = { id: "ord-staff", counterSale: false };
      const e = await errorOf(service.ring(named({ method: "CASH" }) as never, staff, "k-staff"));
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse().code).toBe("COUNTER_SALE_KEY_CONFLICT");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
    });

    it("control: a replay of a real counter sale still resumes", async () => {
      replay = true;
      await expect(
        service.ring(named({ method: "CASH" }) as never, staff, "k-ok"),
      ).resolves.toBeDefined();
    });

    it("a carrier tenant (no fleet, counter optional) still rings PICKUP counter sales", async () => {
      reader.get.mockResolvedValue(cap("optional", { fleet: false, methods: ["SHIP"] }));
      await service.ring(named({ method: "CASH" }) as never, staff);
      expect(createSale).toHaveBeenCalledWith(
        expect.anything(),
        staff,
        expect.objectContaining({ fulfillPath: "PICKUP" }),
      );
    });
  });

  // ── 2/3. selection, tenant scope, walk-in ──────────────────────────────────
  describe("customer selection", () => {
    it("customerId together with walkIn is 400 WALK_IN_WITH_CUSTOMER; neither is a 400", async () => {
      expect(
        await codeOf(service.ring(named({ method: "CASH" }, { walkIn: true }) as never, staff)),
      ).toBe("WALK_IN_WITH_CUSTOMER");
      await expect(
        service.ring({ items: [item], payment: { method: "CASH" } } as never, staff),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(createSale).not.toHaveBeenCalled();
    });

    it("walk-in + ON_ACCOUNT is 400 WALK_IN_NO_ACCOUNT and writes nothing (no walk-in row either)", async () => {
      const p = service.ring(
        { walkIn: true, items: [item], payment: { method: "ON_ACCOUNT" } } as never,
        staff,
      );
      expect(await codeOf(p)).toBe("WALK_IN_NO_ACCOUNT");
      expect(walkIn.getOrCreateWalkIn).not.toHaveBeenCalled();
      expect(createSale).not.toHaveBeenCalled();
    });

    it("another tenant's customer id is a 404 (tenant-scoped lookup) before anything is created", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(service.ring(named({ method: "CASH" }) as never, staff)).rejects.toMatchObject({
        status: 404,
      });
      expect(createSale).not.toHaveBeenCalled();
    });

    it("another tenant's / unknown product id is a 404 before anything is created", async () => {
      prisma.product.findMany.mockResolvedValue([]);
      await expect(service.ring(named({ method: "CASH" }) as never, staff)).rejects.toMatchObject({
        status: 404,
      });
      expect(createSale).not.toHaveBeenCalled();
    });

    it("a walk-in sale sells to the tenant's walk-in customer and suppresses the INVOICE_SENT email", async () => {
      await service.ring(
        { walkIn: true, items: [item], payment: { method: "CASH" } } as never,
        staff,
      );
      expect(walkIn.getOrCreateWalkIn).toHaveBeenCalledTimes(1);
      expect(createSale.mock.calls[0][0].customerId).toBe("cust-walkin");
      expect(createSale.mock.calls[0][2].suppressInvoiceNotify).toBe(true);
    });

    it("a named customer's sale does NOT suppress the invoice email", async () => {
      await service.ring(named({ method: "CASH" }) as never, staff);
      expect(createSale.mock.calls[0][2].suppressInvoiceNotify).toBeFalsy();
    });

    it("a walk-in holding open credit is refused 409 WALK_IN_OPEN_CREDIT BEFORE create (send would auto-apply it)", async () => {
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 4 }]);
      const e = await errorOf(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      );
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse().code).toBe("WALK_IN_OPEN_CREDIT");
      expect(createSale).not.toHaveBeenCalled();
    });

    // The guard must ask the SAME question as markSent's auto-apply (credit-notes/auto-apply-candidates):
    // not just ISSUED. This evaluates the where the guard sends over a table of notes in each state.
    it.each([
      ["an ISSUED note with balance", { status: "ISSUED", expiresAt: null }],
      ["an APPLIED-status note that still holds balance", { status: "APPLIED", expiresAt: null }],
      [
        "an ISSUED note that expires in the future",
        { status: "ISSUED", expiresAt: new Date("2999-01-01") },
      ],
    ])("refuses the walk-in for %s (auto-apply would take it)", async (_n, state) => {
      const table = [{ amount: 10, amountUsed: 4, autoApplyExcluded: false, ...state }];
      prisma.creditNote.findMany.mockImplementation(async ({ where }: any) =>
        table.filter(
          (n: any) =>
            (where.status === undefined ||
              (where.status.not !== undefined
                ? n.status !== where.status.not
                : n.status === where.status)) &&
            (where.autoApplyExcluded === undefined ||
              n.autoApplyExcluded === where.autoApplyExcluded) &&
            (where.OR === undefined ||
              where.OR.some((c: any) =>
                "expiresAt" in c && c.expiresAt === null
                  ? n.expiresAt === null
                  : c.expiresAt?.gt && n.expiresAt && n.expiresAt > c.expiresAt.gt,
              )),
        ),
      );
      const e = await errorOf(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      );
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse().code).toBe("WALK_IN_OPEN_CREDIT");
      expect(createSale).not.toHaveBeenCalled();
    });

    it("does not refuse for a VOID note, an operator-excluded note or an expired one (auto-apply skips them)", async () => {
      const table = [
        { amount: 10, amountUsed: 0, status: "VOID", expiresAt: null, autoApplyExcluded: false },
        { amount: 10, amountUsed: 0, status: "ISSUED", expiresAt: null, autoApplyExcluded: true },
        {
          amount: 10,
          amountUsed: 0,
          status: "ISSUED",
          expiresAt: new Date("2000-01-01"),
          autoApplyExcluded: false,
        },
      ];
      prisma.creditNote.findMany.mockImplementation(async ({ where }: any) =>
        table.filter(
          (n: any) =>
            n.status !== where.status.not &&
            n.autoApplyExcluded === where.autoApplyExcluded &&
            where.OR.some((c: any) =>
              c.expiresAt === null
                ? n.expiresAt === null
                : n.expiresAt && n.expiresAt > c.expiresAt.gt,
            ),
        ),
      );
      await expect(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      ).resolves.toBeDefined();
    });

    it("creditAutoApplyOnSend OFF (the default): open credit does NOT block the walk-in (send() would not apply it)", async () => {
      prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: false });
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 0 }]);
      await expect(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      ).resolves.toBeDefined();
      expect(createSale).toHaveBeenCalled();
    });

    it("no tenant config row reads as OFF: open credit does not block the walk-in", async () => {
      prisma.tenantConfig.findUnique.mockResolvedValue(null);
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 0 }]);
      await expect(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      ).resolves.toBeDefined();
    });

    it("creditAutoApplyOnSend ON: open credit blocks the walk-in (409 WALK_IN_OPEN_CREDIT)", async () => {
      prisma.tenantConfig.findUnique.mockResolvedValue({ creditAutoApplyOnSend: true });
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 0 }]);
      expect(
        await codeOf(
          service.ring(
            { walkIn: true, items: [item], payment: { method: "CASH" } } as never,
            staff,
          ),
        ),
      ).toBe("WALK_IN_OPEN_CREDIT");
    });

    it("a fully consumed credit note does not block the walk-in", async () => {
      prisma.creditNote.findMany.mockResolvedValue([{ amount: 10, amountUsed: 10 }]);
      await expect(
        service.ring({ walkIn: true, items: [item], payment: { method: "CASH" } } as never, staff),
      ).resolves.toBeDefined();
    });
  });

  // ── 4. lines + 5. sequence ─────────────────────────────────────────────────
  describe("lines and sequence", () => {
    it("hands create() (via createSale) the lines as the writer stores them (qty always set); priceReason becomes overrideReason", async () => {
      prisma.product.findMany.mockResolvedValue([{ id: "p1", unitsPerBox: 4 }]);
      await service.ring(
        named(
          { method: "CASH" },
          {
            notes: "front desk",
            items: [
              { productId: "p1", boxes: 1, pieces: 3, unitPrice: 4.5, priceReason: "damaged box" },
              { productId: "p1", qty: 2 },
            ],
          },
        ) as never,
        staff,
        "key-1",
      );
      const dto = createSale.mock.calls[0][0];
      expect(dto).toMatchObject({
        customerId: "cust-1",
        notes: "front desk",
        deliveredNow: true,
        idempotencyKey: "key-1",
      });
      expect(dto.items).toEqual([
        {
          productId: "p1",
          qty: 7, // 1 box of 4 + 3 pieces: the integer the writer stores, so a same-key replay matches
          boxes: 1,
          pieces: 3,
          unitPrice: 4.5,
          overrideReason: "damaged box",
        },
        { productId: "p1", qty: 2 },
      ]);
    });

    it("create()'s existing 400 for an unreasoned price override surfaces untouched", async () => {
      const boom = new BadRequestException("A reason is required to change Widget");
      createSale.mockRejectedValue(boom);
      await expect(
        service.ring(
          named({ method: "CASH" }, { items: [{ ...item, unitPrice: 1 }] }) as never,
          staff,
        ),
      ).rejects.toBe(boom);
      expect(recordPayment).not.toHaveBeenCalled();
    });

    it("createSale is called as a PICKUP counter sale, THEN recordPayment runs; ON_ACCOUNT records none", async () => {
      await service.ring(named({ method: "CASH" }) as never, staff);
      expect(createSale).toHaveBeenCalledWith(
        expect.objectContaining({ deliveredNow: true }),
        staff,
        expect.objectContaining({ fulfillPath: "PICKUP" }),
      );
      expect(createSale.mock.invocationCallOrder[0]).toBeLessThan(
        recordPayment.mock.invocationCallOrder[0],
      );

      recordPayment.mockClear();
      invoices = [inv("inv-1", 37.25)];
      const r = await service.ring(named({ method: "ON_ACCOUNT" }) as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        total: 37.25,
        paid: 0,
        balanceDue: 37.25,
        paymentRecorded: true,
      });
      expect(r.paymentId).toBeUndefined();
    });

    it("never touches stock itself: the only decrement is create()'s own (no inventory collaborator)", () => {
      expect(Object.keys(service as object).filter((k) => /stock|inventory/i.test(k))).toEqual([]);
    });
  });

  // ── 7. money ───────────────────────────────────────────────────────────────
  describe("money", () => {
    it("a VOID sibling invoice of the order is not read back: not the invoice id, not the total, not the balance", async () => {
      const voided = { ...inv("inv-void", 10, [], 0), status: "VOID" };
      invoices = [voided, inv("inv-1", 37.25, [], 1)];
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff);
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ amount: 37.25 }),
        LEG0,
      );
      expect(r).toMatchObject({
        invoiceId: "inv-1",
        total: 37.25,
        paid: 37.25,
        balanceDue: 0,
        change: 12.75,
      });
    });

    it("a WRITTEN_OFF sibling is excluded too (recordPayment refuses both statuses)", async () => {
      invoices = [
        { ...inv("inv-wo", 10, [], 0), status: "WRITTEN_OFF" },
        inv("inv-1", 37.25, [], 1),
      ];
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff);
      expect(r).toMatchObject({ invoiceId: "inv-1", total: 37.25, balanceDue: 0 });
    });

    it("CASH 50 on 37.25: pays 37.25, change 12.75, balance 0", async () => {
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        {
          amount: 37.25,
          method: "CASH",
          reference: undefined,
        },
        LEG0,
      );
      expect(r).toEqual({
        orderId: "ord-1",
        orderNumber: "ORD-1",
        invoiceId: "inv-1",
        invoiceNumber: "N-inv-1",
        total: 37.25,
        paid: 37.25,
        balanceDue: 0,
        change: 12.75,
        paymentId: "pay-inv-1",
        method: "CASH",
        paymentRecorded: true,
      });
    });

    it("CARD exact: recorded as CREDIT_CARD with the reference; no change", async () => {
      const r = await service.ring(named({ method: "CARD", reference: "auth-77" }) as never, staff);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        {
          amount: 37.25,
          method: "CREDIT_CARD",
          reference: "auth-77",
        },
        LEG0,
      );
      expect(r.change).toBeUndefined();
      expect(r.balanceDue).toBe(0);
    });

    it("CHECK without a number is 400 COUNTER_CHECK_NUMBER_REQUIRED BEFORE the sale is created", async () => {
      expect(await codeOf(service.ring(named({ method: "CHECK" }) as never, staff))).toBe(
        "COUNTER_CHECK_NUMBER_REQUIRED",
      );
      expect(createSale).not.toHaveBeenCalled();
    });

    it("CASH 20 on a 37.25 sale: a PARTIAL payment of 20, paid 20, balanceDue read back from storage, no change", async () => {
      const r = await service.ring(named({ method: "CASH", amount: 20 }) as never, staff);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        {
          amount: 20,
          method: "CASH",
          reference: undefined,
        },
        LEG0,
      );
      expect(r).toMatchObject({
        paid: 20,
        balanceDue: 17.25,
        paymentRecorded: true,
        paymentId: "pay-inv-1",
      });
      expect(r.change).toBeUndefined();
      expect(r.paymentErrorCode).toBeUndefined();
    });

    it("a zero CASH tender: the sale stands (open invoice), 201 paymentRecorded:false TENDER_SHORT, no payment", async () => {
      const r = await service.ring(named({ method: "CASH", amount: 0 }) as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_TENDER_SHORT",
        paid: 0,
        balanceDue: 37.25,
      });
    });

    it("CARD above the total is COUNTER_PAYMENT_EXCEEDS_TOTAL, nothing recorded", async () => {
      const r = await service.ring(named({ method: "CARD", amount: 99 }) as never, staff);
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      });
    });

    it("the tender is judged against the POST-send balance (credit already applied by send)", async () => {
      invoices = [
        inv("inv-1", 40, [{ id: "cn-pay", amount: 10, method: "CREDIT_NOTE", status: "PAID" }]),
      ];
      const r = await service.ring(named({ method: "CASH", amount: 30 }) as never, staff);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-1",
        expect.objectContaining({ amount: 30 }),
        LEG0,
      );
      expect(r).toMatchObject({ total: 40, paid: 40, balanceDue: 0, paymentRecorded: true });
      expect(r.change).toBeUndefined();
    });

    it("mixed regulated order: sibling invoices are paid oldest-first from one tender", async () => {
      invoices = [inv("inv-1", 30, [], 1), inv("inv-2", 7.25, [], 2)];
      const r = await service.ring(named({ method: "CASH", amount: 40 }) as never, staff);
      expect(recordPayment.mock.calls.map((c) => [c[0], c[1].amount])).toEqual([
        ["inv-1", 30],
        ["inv-2", 7.25],
      ]);
      expect(r).toMatchObject({ total: 37.25, paid: 37.25, balanceDue: 0, change: 2.75 });
    });
  });

  // ── 8. refusals ────────────────────────────────────────────────────────────
  describe("refusals and partial failure", () => {
    it.each(["CREDIT_LIMIT_EXCEEDED", "REGULATED_AUTH_REQUIRED", "SELLING_RESTRICTED"])(
      "create()'s %s 409 propagates unchanged and no payment is attempted",
      async (code) => {
        const boom = new ConflictException({ code, message: "refused" });
        createSale.mockRejectedValue(boom);
        await expect(service.ring(named({ method: "CASH" }) as never, staff)).rejects.toBe(boom);
        expect(recordPayment).not.toHaveBeenCalled();
      },
    );

    it("recordPayment failing AFTER the sale committed: 201, paymentRecorded:false, the invoice stays open", async () => {
      recordPayment.mockRejectedValue(new Error("db went away"));
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff);
      expect(r).toMatchObject({
        invoiceId: "inv-1",
        total: 37.25,
        paid: 0,
        balanceDue: 37.25,
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      });
      expect(r.change).toBeUndefined(); // no money moved, so no change is owed
    });
  });

  // ── 9. idempotency ─────────────────────────────────────────────────────────
  describe("Idempotency-Key", () => {
    it("the same key twice: createSale replays, exactly ONE payment, identical response + replayed:true", async () => {
      const first = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      replay = true;
      const second = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ ...first, replayed: true });
      expect(first.replayed).toBeUndefined();
    });

    it("a replay after a refused (zero) tender finishes the sale when retried with a corrected payment", async () => {
      await service.ring(named({ method: "CASH", amount: 0 }) as never, staff, "k");
      expect(recordPayment).not.toHaveBeenCalled();
      replay = true;
      const retry = await service.ring(named({ method: "CASH", amount: 40 }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(retry).toMatchObject({ paymentRecorded: true, paid: 37.25, replayed: true });
    });

    it("a replay after a PARTIAL payment records nothing more and reports what is stored", async () => {
      await service.ring(named({ method: "CASH", amount: 20 }) as never, staff, "k");
      replay = true;
      const again = await service.ring(named({ method: "CASH", amount: 20 }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(again).toMatchObject({
        paid: 20,
        balanceDue: 17.25,
        paymentRecorded: true,
        replayed: true,
      });
    });

    it("paymentRecorded on a replay comes from what is STORED, not from this call", async () => {
      invoices = [
        inv("inv-1", 37.25, [{ id: "p0", amount: 37.25, method: "CASH", status: "PAID" }]),
      ];
      replay = true;
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ paymentRecorded: true, paid: 37.25, paymentId: "p0" });
    });

    it("a VOID payment does not count: the replay records a fresh one", async () => {
      invoices = [
        inv("inv-1", 37.25, [{ id: "p0", amount: 37.25, method: "CASH", status: "VOID" }]),
      ];
      replay = true;
      await service.ring(named({ method: "CASH" }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
    });

    it("a concurrent double submit: the loser's payment is refused by the invoice lock, the stored payment makes it paymentRecorded:true, one payment exists", async () => {
      // Both requests read the invoice before either paid (the stale first read of the loser).
      const stale = invoices.map((i) => ({
        ...i,
        payments: [] as any[],
        invoiceNumber: "N-inv-1",
      }));
      await service.ring(named({ method: "CASH" }) as never, staff, "k");
      replay = true;
      prisma.invoice.findMany.mockResolvedValueOnce(stale);
      const loser = await service.ring(named({ method: "CASH" }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(2); // the loser tried; the invoice row lock said no
      expect(invoices[0].payments).toHaveLength(1);
      expect(loser).toMatchObject({ paymentRecorded: true, replayed: true, paid: 37.25 });
    });
  });

  describe("serialised tender (SA-672 M1) and a failing sibling allocation (M2)", () => {
    const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

    it("the payment step runs inside the shared counter-tender advisory lock keyed on the order", async () => {
      await service.ring(named({ method: "CASH", amount: 20 }) as never, staff, "k");
      expect(mockLockCalls).toEqual([{ family: "counter-tender", key: "ord-1", mode: "wait" }]);
    });

    it("two concurrent same-key SHORT tenders record exactly ONE payment", async () => {
      // A slow recordPayment holds the race window open: without the lock both calls read 'no tender yet'.
      recordPayment.mockImplementation(async (invoiceId: string, dto: any) => {
        await tick();
        invoices
          .find((i) => i.id === invoiceId)!
          .payments.push({
            id: `pay-${invoiceId}`,
            amount: dto.amount,
            method: dto.method,
            status: "PAID",
          });
        return { id: invoiceId, createdPaymentId: `pay-${invoiceId}` };
      });
      const [a, b] = await Promise.all([
        service.ring(named({ method: "CASH", amount: 20 }) as never, staff, "k"),
        service.ring(named({ method: "CASH", amount: 20 }) as never, staff, "k"),
      ]);
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(invoices[0].payments).toHaveLength(1);
      expect(a).toMatchObject({ paid: 20, balanceDue: 17.25, paymentRecorded: true });
      expect(b).toMatchObject({ paid: 20, balanceDue: 17.25, paymentRecorded: true });
    });

    it.each([
      ["a lock timeout", () => new LockTimeoutError("counter-tender", "ord-1", 20000)],
      ["an unavailable lock connection", () => new LockUnavailableError(new Error("pool"))],
    ])(
      "%s AFTER the sale committed => 201 paymentRecorded:false + a code, never a 500",
      async (_n, mk) => {
        mockLockFailure.error = mk();
        const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
        expect(recordPayment).not.toHaveBeenCalled();
        expect(r).toMatchObject({
          orderId: "ord-1",
          invoiceId: "inv-1",
          total: 37.25,
          paid: 0,
          balanceDue: 37.25,
          paymentRecorded: false,
          paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
        });
        expect(r.change).toBeUndefined();
      },
    );

    it("a non-lock failure inside the locked section still propagates (only the lock errors are mapped)", async () => {
      mockLockFailure.error = new Error("boom");
      await expect(
        service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k"),
      ).rejects.toThrow("boom");
    });

    it("a replay after a failed sibling allocation RESUMES: only the missing part is recorded, paid = total", async () => {
      invoices = [inv("inv-1", 30, [], 1), inv("inv-2", 20, [], 2)];
      let failSibling = true;
      recordPayment.mockImplementation(async (invoiceId: string, dto: any) => {
        if (invoiceId === "inv-2" && failSibling)
          throw new BadRequestException("regulated refused");
        invoices
          .find((i) => i.id === invoiceId)!
          .payments.push({
            id: `pay-${invoiceId}`,
            amount: dto.amount,
            method: dto.method,
            status: "PAID",
          });
        return { id: invoiceId, createdPaymentId: `pay-${invoiceId}` };
      });
      const first = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(first).toMatchObject({ paid: 30, balanceDue: 20, paymentRecorded: false });

      failSibling = false;
      replay = true;
      recordPayment.mockClear();
      const second = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(recordPayment).toHaveBeenCalledTimes(1);
      expect(recordPayment).toHaveBeenCalledWith(
        "inv-2",
        expect.objectContaining({ amount: 20 }),
        LEG0,
      );
      expect(second).toMatchObject({
        total: 50,
        paid: 50,
        balanceDue: 0,
        paymentRecorded: true,
        replayed: true,
      });
      expect(invoices[0].payments).toHaveLength(1); // sibling 1 is never charged twice
    });

    it("a replay whose planned allocation is already fully stored records nothing", async () => {
      invoices = [
        inv("inv-1", 30, [{ id: "p1", amount: 30, method: "CASH", status: "PAID" }], 1),
        inv("inv-2", 20, [{ id: "p2", amount: 20, method: "CASH", status: "PAID" }], 2),
      ];
      replay = true;
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ paid: 50, paymentRecorded: true });
    });

    it("a resume never over-collects: a tender above the plan on one invoice is not topped up elsewhere", async () => {
      // 20 tendered, sibling 1 already holds 20 (its whole planned share): nothing more is due.
      invoices = [
        inv("inv-1", 30, [{ id: "p1", amount: 20, method: "CASH", status: "PAID" }], 1),
        inv("inv-2", 20, [], 2),
      ];
      replay = true;
      const r = await service.ring(named({ method: "CASH", amount: 20 }) as never, staff, "k");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(r).toMatchObject({ paid: 20, balanceDue: 30, paymentRecorded: true });
    });

    it("a replay whose resume still cannot record: paymentRecorded:false, NO change, balanceDue stays 20", async () => {
      invoices = [inv("inv-1", 30, [], 1), inv("inv-2", 20, [], 2)];
      recordPayment.mockImplementation(async (invoiceId: string, dto: any) => {
        if (invoiceId === "inv-2") throw new BadRequestException("regulated refused");
        invoices
          .find((i) => i.id === invoiceId)!
          .payments.push({
            id: `pay-${invoiceId}`,
            amount: dto.amount,
            method: dto.method,
            status: "PAID",
          });
        return { id: invoiceId, createdPaymentId: `pay-${invoiceId}` };
      });
      await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      replay = true;
      const again = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(again).toMatchObject({
        paid: 30,
        balanceDue: 20,
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      });
      expect(again.change).toBeUndefined();
    });

    it("change comes ONLY from a fully covered STORED balance, never from this call's tender against stored cash", async () => {
      // Sibling 1 holds its 30 of cash; sibling 2's recordPayment answers OK but nothing is stored for it
      // (the stored balance is still 20). This call's tender (50) minus the stored cash (30) is 20, which
      // is money still OWED, not change to hand back.
      invoices = [
        inv("inv-1", 30, [{ id: "p1", amount: 30, method: "CASH", status: "PAID" }], 1),
        inv("inv-2", 20, [], 2),
      ];
      recordPayment.mockResolvedValue({ id: "inv-2", createdPaymentId: "x" });
      replay = true;
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(r.balanceDue).toBe(20);
      expect(r.change).toBeUndefined();
    });

    it("a fully covered stored balance returns change from the tender (CASH 60 on a 50 sale = 10)", async () => {
      invoices = [inv("inv-1", 30, [], 1), inv("inv-2", 20, [], 2)];
      const r = await service.ring(named({ method: "CASH", amount: 60 }) as never, staff, "k");
      expect(r).toMatchObject({ paid: 50, balanceDue: 0, change: 10, paymentRecorded: true });
    });

    it("a sibling-invoice allocation that throws reports paymentRecorded:false + a code, never a 500 or a silent true; paid/balance come from storage", async () => {
      invoices = [inv("inv-1", 30, [], 1), inv("inv-2", 20, [], 2)];
      recordPayment.mockImplementation(async (invoiceId: string, dto: any) => {
        if (invoiceId === "inv-2") throw new BadRequestException("regulated line refused");
        invoices
          .find((i) => i.id === invoiceId)!
          .payments.push({
            id: `pay-${invoiceId}`,
            amount: dto.amount,
            method: dto.method,
            status: "PAID",
          });
        return { id: invoiceId, createdPaymentId: `pay-${invoiceId}` };
      });
      const r = await service.ring(named({ method: "CASH", amount: 50 }) as never, staff, "k");
      expect(r).toMatchObject({
        total: 50,
        paid: 30,
        balanceDue: 20,
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      });
      expect(r.change).toBeUndefined();
    });
  });

  describe("byKey (GET /orders/counter-sale/by-key/:key): a definitive answer about a key", () => {
    // SA-672e: a counter sale is recognised by the durable Order.counterSale marker (set only by the counter
    // POST), not by its shape: skipAutoMerge/PICKUP are written by other paths too.
    const sale = {
      id: "ord-1",
      orderNumber: "ORD-1",
      fulfillPath: "PICKUP",
      skipAutoMerge: true,
      counterSale: true,
      status: "DELIVERED",
      customerId: "cust-1",
    };

    it("found: the same body a replay would return, read back from storage, replayed:true, nothing written", async () => {
      findReplayCandidateByKey.mockResolvedValue(sale);
      invoices = [
        inv("inv-1", 37.25, [{ id: "p0", amount: 37.25, method: "CASH", status: "PAID" }]),
      ];
      const r = await service.byKey("k1");
      expect(r).toEqual({
        orderId: "ord-1",
        orderNumber: "ORD-1",
        invoiceId: "inv-1",
        invoiceNumber: "N-inv-1",
        total: 37.25,
        paid: 37.25,
        balanceDue: 0,
        paymentId: "p0",
        method: "CASH",
        paymentRecorded: true,
        replayed: true,
      });
      expect(findReplayCandidateByKey).toHaveBeenCalledWith("k1", expect.any(String));
      expect(createSale).not.toHaveBeenCalled();
      expect(recordPayment).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(walkIn.getOrCreateWalkIn).not.toHaveBeenCalled();
    });

    it("matches what the POST replay returns for the same stored sale (modulo change, which needs the tender)", async () => {
      invoices = [inv("inv-1", 37.25)];
      const first = await service.ring(
        named({ method: "CASH", amount: 37.25 }) as never,
        staff,
        "k",
      );
      findReplayCandidateByKey.mockResolvedValue(sale);
      const { change: _c, ...expected } = { ...first, replayed: true } as any;
      expect(await service.byKey("k")).toEqual(expected);
    });

    it("a PARTIAL stored tender (balance still owing) is NOT paymentRecorded: storage cannot tell an intended partial from an interrupted allocation, so the till must see money is owed", async () => {
      findReplayCandidateByKey.mockResolvedValue(sale);
      invoices = [inv("inv-1", 37.25, [{ id: "p0", amount: 20, method: "CASH", status: "PAID" }])];
      expect(await service.byKey("k1")).toMatchObject({
        paid: 20,
        balanceDue: 17.25,
        method: "CASH",
        paymentRecorded: false,
        paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
      });
    });

    it("recovered ON ACCOUNT: no tender, balance owing => method ON_ACCOUNT, recorded, no error (on account, not 'payment not recorded')", async () => {
      findReplayCandidateByKey.mockResolvedValue(sale);
      const r = await service.byKey("k1");
      expect(r).toMatchObject({
        paid: 0,
        balanceDue: 37.25,
        method: "ON_ACCOUNT",
        paymentRecorded: true,
      });
      expect(r.paymentErrorCode).toBeUndefined();
      expect(r.change).toBeUndefined();
    });

    // L-167: ONE read-back builds both bodies, so a recovered sale reads exactly like the POST that rang it.
    describe.each([
      ["ON_ACCOUNT", { method: "ON_ACCOUNT" }, undefined],
      ["CASH", { method: "CASH", amount: 37.25 }, undefined],
      ["CARD", { method: "CARD" }, "CREDIT_CARD"],
      ["CHECK", { method: "CHECK", reference: "1042" }, "CHECK"],
    ])("a recovered %s sale", (label, payment, _prisma) => {
      it("byKey body equals the POST body (except replayed:true and the cash-only change)", async () => {
        invoices = [inv("inv-1", 37.25)];
        const posted = await service.ring(
          { customerId: "cust-1", items: [item], payment } as never,
          staff,
          `k-${label}`,
        );
        findReplayCandidateByKey.mockResolvedValue(sale);
        const { change: _c, replayed: _r, ...expected } = posted as any;
        const recovered = await service.byKey(`k-${label}`);
        expect(recovered).toEqual({ ...expected, replayed: true });
        expect(recovered.method).toBe(label);
      });
    });

    // S2: the till says which method it rang (?method=); POST's EXACT paymentRecorded rule then applies to it.
    describe("byKey(key, method): the till's own method decides, by POST's rule", () => {
      it.each(["CASH", "CARD", "CHECK"] as const)(
        "a %s sale whose tender failed completely: paymentRecorded:false + COUNTER_PAYMENT_NOT_RECORDED, never ON_ACCOUNT/true",
        async (method) => {
          findReplayCandidateByKey.mockResolvedValue(sale);
          invoices = [inv("inv-1", 37.25)];
          const r = await service.byKey("k1", method);
          expect(r).toMatchObject({
            method,
            paid: 0,
            balanceDue: 37.25,
            paymentRecorded: false,
            paymentErrorCode: "COUNTER_PAYMENT_NOT_RECORDED",
          });
          expect(r.method).not.toBe("ON_ACCOUNT");
        },
      );

      it("ON_ACCOUNT: recorded with the balance owing (nothing was asked of the till)", async () => {
        findReplayCandidateByKey.mockResolvedValue(sale);
        invoices = [inv("inv-1", 37.25)];
        expect(await service.byKey("k1", "ON_ACCOUNT")).toMatchObject({
          method: "ON_ACCOUNT",
          balanceDue: 37.25,
          paymentRecorded: true,
        });
      });

      it.each([
        ["CASH", "CASH"],
        ["CARD", "CREDIT_CARD"],
        ["CHECK", "CHECK"],
      ] as const)("a %s sale with its tender stored is recorded", async (method, stored) => {
        findReplayCandidateByKey.mockResolvedValue(sale);
        invoices = [
          inv("inv-1", 37.25, [{ id: "p0", amount: 37.25, method: stored, status: "PAID" }]),
        ];
        expect(await service.byKey("k1", method)).toMatchObject({
          method,
          paid: 37.25,
          balanceDue: 0,
          paymentRecorded: true,
        });
      });

      it("the rule is POST's: a stored partial tender reads recorded when the till rang that method", async () => {
        findReplayCandidateByKey.mockResolvedValue(sale);
        invoices = [
          inv("inv-1", 37.25, [{ id: "p0", amount: 20, method: "CASH", status: "PAID" }]),
        ];
        expect(await service.byKey("k1", "CASH")).toMatchObject({
          paid: 20,
          balanceDue: 17.25,
          paymentRecorded: true,
        });
      });

      it("byKey with ?method equals the POST body that rang it (except replayed:true and change)", async () => {
        invoices = [inv("inv-1", 37.25)];
        const posted = await service.ring(named({ method: "CARD" }) as never, staff, "k-card");
        findReplayCandidateByKey.mockResolvedValue(sale);
        const { replayed: _r, change: _c, ...expected } = posted as any;
        expect(await service.byKey("k-card", "CARD")).toEqual({ ...expected, replayed: true });
      });

      it("without ?method today's behaviour is kept (derived from storage)", async () => {
        findReplayCandidateByKey.mockResolvedValue(sale);
        invoices = [inv("inv-1", 37.25)];
        expect(await service.byKey("k1")).toMatchObject({
          method: "ON_ACCOUNT",
          paymentRecorded: true,
        });
      });
    });

    it("the tender method maps Prisma CREDIT_CARD back to CARD", async () => {
      findReplayCandidateByKey.mockResolvedValue(sale);
      invoices = [
        inv("inv-1", 37.25, [{ id: "p0", amount: 37.25, method: "CREDIT_CARD", status: "PAID" }]),
      ];
      expect((await service.byKey("k1")).method).toBe("CARD");
    });

    it("a buyer's PICKUP order (no counterSale, no skipAutoMerge) is a 404", async () => {
      findReplayCandidateByKey.mockResolvedValue({
        ...sale,
        skipAutoMerge: false,
        counterSale: false,
      });
      const e = await service.byKey("k1").then(
        () => null,
        (err) => err,
      );
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_NOT_FOUND" });
    });

    it("no invoice rows at all on a PENDING or DELIVERED order: COUNTER_SALE_INCOMPLETE (re-POST finishes it)", async () => {
      for (const status of ["PENDING", "DELIVERED"]) {
        findReplayCandidateByKey.mockResolvedValue({ ...sale, status });
        invoices = [];
        const e = await service.byKey("k1").then(
          () => null,
          (err) => err,
        );
        expect(e.getStatus()).toBe(409);
        expect(e.getResponse()).toMatchObject({
          code: "COUNTER_SALE_INCOMPLETE",
          message: expect.stringMatching(/re-POST with the same key/i),
        });
      }
    });

    // SA-672c: a voided or cancelled sale must never read as "finish it": a re-POST would invoice and charge again.
    it("ring then VOID the invoice: by-key says COUNTER_SALE_VOIDED (definitive), never INCOMPLETE", async () => {
      invoices = [inv("inv-1", 37.25)];
      await service.ring(named({ method: "CASH", amount: 40 }) as never, staff, "k-void");
      invoices[0].status = "VOID"; // the invoice was voided after the sale was rung
      findReplayCandidateByKey.mockResolvedValue({ ...sale, status: "DELIVERED" });
      const e = await service.byKey("k-void").then(
        () => null,
        (err) => err,
      );
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({
        code: "COUNTER_SALE_VOIDED",
        message: "This sale was voided after it was rung — start a new sale.",
      });
    });

    it("only VOID / WRITTEN_OFF invoices exist: COUNTER_SALE_VOIDED", async () => {
      findReplayCandidateByKey.mockResolvedValue({ ...sale, status: "DELIVERED" });
      invoices = [
        { ...inv("inv-v", 10, [], 0), status: "VOID" },
        { ...inv("inv-w", 10, [], 1), status: "WRITTEN_OFF" },
      ];
      const e = await service.byKey("k1").then(
        () => null,
        (err) => err,
      );
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_VOIDED" });
    });

    it("a CANCELLED order is COUNTER_SALE_VOIDED, even with a live invoice", async () => {
      findReplayCandidateByKey.mockResolvedValue({ ...sale, status: "CANCELLED" });
      invoices = [inv("inv-1", 37.25)];
      const e = await service.byKey("k1").then(
        () => null,
        (err) => err,
      );
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_VOIDED" });
    });

    // SA-672d: a PAID sale that staff moved on is still a live sale, never "voided" (a new ring would charge twice).
    it.each(["CONFIRMED", "PARTIALLY_DELIVERED", "OUT_FOR_DELIVERY"])(
      "ring (paid) then staff move it to %s: by-key is the live read-back, not VOIDED",
      async (status) => {
        invoices = [inv("inv-1", 37.25)];
        await service.ring(named({ method: "CASH", amount: 40 }) as never, staff, "k-moved");
        findReplayCandidateByKey.mockResolvedValue({ ...sale, status });
        const r = await service.byKey("k-moved", "CASH");
        expect(r).toMatchObject({
          orderId: "ord-1",
          paid: 37.25,
          balanceDue: 0,
          paymentRecorded: true,
          replayed: true,
        });
      },
    );

    it.each(["CONFIRMED", "PARTIALLY_DELIVERED", "OUT_FOR_DELIVERY"])(
      "an order moved to %s with NO invoice rows is a definitive 409 COUNTER_SALE_CHANGED (neither VOIDED nor ORDER_CHANGED)",
      async (status) => {
        findReplayCandidateByKey.mockResolvedValue({ ...sale, status });
        invoices = [];
        const e = await service.byKey("k1").then(
          () => null,
          (err) => err,
        );
        expect(e.getStatus()).toBe(409);
        expect(e.getResponse()).toEqual({
          code: "COUNTER_SALE_CHANGED",
          message: "This sale was changed after it was rung — check with the office.",
        });
      },
    );

    it("a moved order whose invoices are all VOID is still VOIDED", async () => {
      findReplayCandidateByKey.mockResolvedValue({ ...sale, status: "CONFIRMED" });
      invoices = [{ ...inv("inv-v", 10, [], 0), status: "VOID" }];
      const e = await service.byKey("k1").then(
        () => null,
        (err) => err,
      );
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_VOIDED" });
    });

    it("ring then cancel the order: by-key is VOIDED", async () => {
      invoices = [inv("inv-1", 37.25)];
      await service.ring(named({ method: "CASH", amount: 40 }) as never, staff, "k-cancel");
      findReplayCandidateByKey.mockResolvedValue({ ...sale, status: "CANCELLED" });
      const e = await service.byKey("k-cancel").then(
        () => null,
        (err) => err,
      );
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_VOIDED" });
    });

    it("not found: 404 with the coded COUNTER_SALE_NOT_FOUND (a definitive 'no sale for this key')", async () => {
      const e = await service.byKey("nope").then(
        () => null,
        (err) => err,
      );
      expect(e.getStatus()).toBe(404);
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_NOT_FOUND" });
    });

    it("an ordinary PICKUP + skipAutoMerge order (counterSale false) found by the key is not a sale: coded 404", async () => {
      findReplayCandidateByKey.mockResolvedValue({ ...sale, counterSale: false });
      const e = await service.byKey("k1").then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_NOT_FOUND" });
    });

    it("an order with no counterSale field at all (an older shape) is not a sale: coded 404", async () => {
      const { counterSale: _c, ...bare } = sale;
      findReplayCandidateByKey.mockResolvedValue(bare);
      const e = await service.byKey("k1").then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.getResponse()).toMatchObject({ code: "COUNTER_SALE_NOT_FOUND" });
    });

    it("a counter sale whose fulfillPath later moved off PICKUP is still a live sale (the marker, not the shape)", async () => {
      findReplayCandidateByKey.mockResolvedValue({ ...sale, fulfillPath: "SHIP" });
      invoices = [inv("inv-1", 37.25)];
      await expect(service.byKey("k1")).resolves.toMatchObject({
        orderId: "ord-1",
        replayed: true,
      });
    });

    it("is NOT gated by the counter capability: it answers even when the counter is off", async () => {
      reader.get.mockResolvedValue(cap("off"));
      findReplayCandidateByKey.mockResolvedValue(sale);
      await expect(service.byKey("k1")).resolves.toMatchObject({ orderId: "ord-1" });
      expect(reader.get).not.toHaveBeenCalled();
    });

    it("a caller with no tenant scope is refused (the lookup would otherwise span every tenant)", async () => {
      prisma.getTenantId.mockReturnValue(null);
      findReplayCandidateByKey.mockResolvedValue(sale);
      await expect(service.byKey("k1")).rejects.toMatchObject({ status: 403 });
      expect(findReplayCandidateByKey).not.toHaveBeenCalled();
    });
  });
  // ── POS-5: price edit behind canEditPrices ────────────────────────────────
  describe("price edit (POS-5)", () => {
    const admin = { sub: "adm-1", role: "TENANT_ADMIN", tenantId: "t-1" } as never;
    const superAdmin = { sub: "sa-1", role: "SUPER_ADMIN", tenantId: "t-1" } as never;
    const priced = { productId: "p1", qty: 2, unitPrice: 9, priceReason: "damaged box" };
    const storedLine = {
      productId: "p1",
      unitPrice: 9,
      originalPrice: 10,
      priceType: "DISCOUNTED",
      overrideReason: "damaged box",
      overriddenBy: "adm-1",
    };
    const sendOpts = () => createSale.mock.calls[0][2];

    it.each([
      ["OPERATOR", staff, false],
      ["TENANT_ADMIN", admin, true],
      ["SUPER_ADMIN", superAdmin, true],
    ])("%s: create() is told priceEditAllowed = %s", async (_r, user, allowed) => {
      await service.ring(named({ method: "CASH" }) as never, user);
      expect(sendOpts().priceEditAllowed).toBe(allowed);
    });

    it("a refusal from create() (403 PRICE_EDIT_NOT_PERMITTED) leaves everything unwritten: no payment, no audit row", async () => {
      const { ForbiddenException } = jest.requireActual("@nestjs/common");
      createSale.mockRejectedValue(
        new ForbiddenException({ code: "PRICE_EDIT_NOT_PERMITTED", message: "no" }),
      );
      const e = await errorOf(
        service.ring(named({ method: "CASH" }, { items: [priced] }) as never, staff, "k-1"),
      );
      expect(e.getStatus()).toBe(403);
      expect(e.getResponse().code).toBe("PRICE_EDIT_NOT_PERMITTED");
      expect(recordPayment).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(mockLockCalls).toHaveLength(0);
    });

    it("an admin sale with an edited line writes exactly ONE counter-sale.price-edited row, from STORED values", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        lineItems: [storedLine],
      });
      prisma.product.findMany.mockResolvedValue([{ id: "p1", pricePerUnit: 10, priceTier2: 9.5 }]);
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 2 });
      const imp = { ...(admin as object), impersonatedBy: "plat-1" } as never;
      await service.ring(named({ method: "CASH" }, { items: [priced] }) as never, imp, "k-1");
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log).toHaveBeenCalledWith({
        tenantId: "test-tenant",
        userId: "adm-1",
        impersonatedBy: "plat-1",
        action: "counter-sale.price-edited",
        entityType: "Order",
        entityId: "ord-1",
        meta: {
          orderNumber: "ORD-1",
          lines: [
            {
              productId: "p1",
              originalPrice: 10,
              tierPrice: 9.5,
              unitPrice: 9,
              priceType: "DISCOUNTED",
              reason: "damaged box",
            },
          ],
        },
      });
    });

    it("the audit row records the TIER price the edit started from, next to the LIST price (customer tier, per-product override, null when unresolved)", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        lineItems: [
          { ...storedLine, productId: "p1" },
          { ...storedLine, productId: "p2", originalPrice: 20, unitPrice: 15 },
          { ...storedLine, productId: "p3", originalPrice: 5, unitPrice: 4 },
          { ...storedLine, productId: null, originalPrice: null, unitPrice: 3 },
        ],
      });
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 3 });
      // p2 carries a per-product tier override (tier 2); p1 follows the customer's default tier 3.
      prisma.customerPrice.findMany.mockResolvedValue([{ productId: "p2", pricingTier: 2 }]);
      // the first product read is the sale's own existence check (the one item); the second is the tier lookup
      prisma.product.findMany.mockResolvedValueOnce([{ id: "p1", pricePerUnit: 10 }]);
      prisma.product.findMany.mockResolvedValue([
        { id: "p1", pricePerUnit: 10, priceTier2: 9.5, priceTier3: 9.25 },
        { id: "p2", pricePerUnit: 20, priceTier2: 18, priceTier3: 17 },
      ]);
      await service.ring(named({ method: "CASH" }, { items: [priced] }) as never, admin, "k-1");
      const lines = audit.log.mock.calls[0][0].meta.lines;
      expect(lines.map((l: any) => [l.productId, l.originalPrice, l.tierPrice])).toEqual([
        ["p1", 10, 9.25],
        ["p2", 20, 18],
        ["p3", 5, null],
        [null, null, null],
      ]);
    });

    it("a failed tier-price lookup still writes the audit row, with a null tier price", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        lineItems: [storedLine],
      });
      prisma.customerPrice.findMany.mockRejectedValue(new Error("db down"));
      await service.ring(named({ method: "CASH" }, { items: [priced] }) as never, admin, "k-1");
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log.mock.calls[0][0].meta.lines[0]).toMatchObject({
        originalPrice: 10,
        tierPrice: null,
      });
    });

    it("a sale with no edited line writes no audit row", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        lineItems: [],
      });
      await service.ring(named({ method: "CASH" }) as never, admin, "k-1");
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("a replayed sale writes no second audit row", async () => {
      replay = true;
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        lineItems: [storedLine],
      });
      await service.ring(named({ method: "CASH" }, { items: [priced] }) as never, admin, "k-1");
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("an audit failure never fails the sale", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-1",
        orderNumber: "ORD-1",
        lineItems: [storedLine],
      });
      audit.log.mockRejectedValue(new Error("db down"));
      await expect(
        service.ring(named({ method: "CASH" }, { items: [priced] }) as never, admin, "k-1"),
      ).resolves.toMatchObject({ orderId: "ord-1" });
    });

    describe("replay compares price and discount like any other cart change", () => {
      const stored = (over: any = {}) => ({
        id: "ord-1",
        counterSale: true,
        lineItems: [
          {
            productId: "p1",
            position: 0,
            status: "ACTIVE",
            unitPrice: 9,
            overriddenBy: "adm-1",
            ...over,
          },
        ],
      });
      const ringWith = (item: any, order: any) => {
        replay = true;
        replayOrder = order;
        return service.ring(named({ method: "CASH" }, { items: [item] }) as never, admin, "k-1");
      };

      it("the same priced body replays (same order, replayed:true)", async () => {
        await expect(ringWith(priced, stored())).resolves.toMatchObject({
          orderId: "ord-1",
          replayed: true,
        });
      });

      it("a different price under the same key is 409 IDEMPOTENCY_KEY_CART_MISMATCH carrying the holding order id", async () => {
        const e = await errorOf(ringWith({ ...priced, unitPrice: 8 }, stored()));
        expect(e.getStatus()).toBe(409);
        expect(e.getResponse()).toMatchObject({
          code: "IDEMPOTENCY_KEY_CART_MISMATCH",
          orderId: "ord-1",
        });
        expect(recordPayment).not.toHaveBeenCalled();
      });

      it("a price within 1/2 cent of the stored one is the same price (3.335 stores 3.34)", async () => {
        await expect(
          ringWith({ ...priced, unitPrice: 3.335 }, stored({ unitPrice: 3.34 })),
        ).resolves.toMatchObject({ replayed: true });
      });

      it("an unpriced body against a stored override is a changed cart", async () => {
        const e = await errorOf(ringWith({ productId: "p1", qty: 2 }, stored()));
        expect(e.getResponse().code).toBe("IDEMPOTENCY_KEY_CART_MISMATCH");
      });

      it("an unpriced body against an unpriced stored line is the plain replay of today", async () => {
        await expect(
          ringWith({ productId: "p1", qty: 2 }, stored({ unitPrice: 10, overriddenBy: null })),
        ).resolves.toMatchObject({ replayed: true });
      });

      it("an order that carries no line detail (older fixture) is not judged", async () => {
        await expect(ringWith(priced, { id: "ord-1", counterSale: true })).resolves.toBeDefined();
      });
    });
  });
});
