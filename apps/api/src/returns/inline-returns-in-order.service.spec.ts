/**
 * #2094 PR-A (SA-194 / SA-221): the in-transaction core of an inline return, used by order
 * create/edit. `captureInTx` is capture()'s transaction body verbatim minus the advisory lock (the
 * CALLER holds it: the order paths take it as their first statement, before any row lock);
 * `captureAndIssueInTx` adds the credit issue in the SAME transaction (mint at a pre-reserved
 * number, link, orderCreditNote, settle) unless the return is held above the driver cap.
 * Pricing is stubbed; the real-Postgres pins live in inline-returns-in-order.db.spec.ts.
 */
import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { InlineReturnsService } from "./inline-returns.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { AddonService } from "../billing/addon.service";
import { IdempotencyService } from "../common/idempotency.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = (role: string, sub = "u1"): JwtPayload =>
  ({ sub, role, tenantId: "t1", tenantSlug: "acme", status: "ACTIVE" }) as JwtPayload;
const OPERATOR = user("OPERATOR", "op-1");
const DRIVER = user("DRIVER", "drv-1");
const CUSTOMER = user("CUSTOMER", "cust-user");

const priced = (total = 30) => ({
  chunks: [
    {
      sourceOrderId: "src-1",
      sourceInvoiceItemId: "ii-1",
      sourceOrderItemId: "oi-1",
      productId: "prod-1",
      pieces: 6,
      subtotal: total - 2,
      taxAmount: 2,
      categoryTax: 0,
      priceSource: "SOURCE_INVOICE" as const,
      unitPrice: (total - 2) / 6,
    },
  ],
  subtotal: total - 2,
  taxAmount: 2,
  categoryTax: 0,
  total,
  productBreakdown: {},
});

const INPUT = {
  customerId: "cust-1",
  orderId: "ord-new",
  items: [{ productId: "prod-1", boxes: 0, pieces: 6 }],
  returnKey: "attempt-1",
};

describe("InlineReturnsService in-transaction core (#2094)", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let quote: { priceInlineReturn: jest.Mock };
  let creditNotes: { mintStandaloneInTx: jest.Mock; settleOrderCreditsInTx: jest.Mock };
  let numbering: { reserveNext: jest.Mock };
  let addon: { hasAddon: jest.Mock };
  let idempotency: { acquireLock: jest.Mock; hashFor: jest.Mock };
  let tx: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    tx = prisma; // the mock client doubles as the tx client
    quote = { priceInlineReturn: jest.fn().mockResolvedValue(priced()) };
    creditNotes = {
      mintStandaloneInTx: jest.fn((_tx: any, dto: any) =>
        Promise.resolve({
          id: "cn-1",
          creditNoteNumber: "CN-2026-0007",
          customerId: dto.customerId,
          amount: dto.amount,
        }),
      ),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    };
    numbering = { reserveNext: jest.fn().mockResolvedValue("RET-2026-0001") };
    addon = { hasAddon: jest.fn().mockResolvedValue(true) };
    idempotency = {
      acquireLock: jest.fn().mockResolvedValue(undefined),
      hashFor: jest.fn((k: string, t: string | null, s: string) => `${t}:${s}:${k}`),
    };
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-new",
      customerId: "cust-1",
      total: 100,
      status: "PENDING",
      routeRunId: null,
    });
    prisma.routeRunStop.findFirst.mockResolvedValue({ routeRunId: "run-1" });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.orderCreditNote.aggregate.mockResolvedValue({ _sum: { amount: null } });
    prisma.return.findFirst.mockResolvedValue(null);
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.create.mockImplementation(async ({ data }: any) => ({
      id: "ret-1",
      ...data,
      items: (data.items?.create ?? []).map((i: any, n: number) => ({ id: `ri-${n}`, ...i })),
    }));
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CreditNotesService, useValue: creditNotes },
        { provide: NumberingService, useValue: numbering },
        { provide: AddonService, useValue: addon },
        { provide: InlineReturnsQuoteService, useValue: quote },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  describe("captureInTx", () => {
    it("never takes the customer advisory lock itself: the caller holds it", async () => {
      await (service as any).captureInTx(tx, INPUT, OPERATOR);
      expect(idempotency.acquireLock).not.toHaveBeenCalled();
    });

    it("creates the Return on the caller's tx and returns it un-issued (no mint here)", async () => {
      const out = await (service as any).captureInTx(tx, INPUT, OPERATOR);
      expect(out).toMatchObject({ replayed: false, overCap: false });
      expect(out.ret).toMatchObject({ id: "ret-1", status: "RECEIVED", orderId: "ord-new" });
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("replay: the same returnKey for the same customer and order returns the existing row, creating nothing", async () => {
      prisma.return.findFirst.mockResolvedValueOnce({
        id: "ret-old",
        customerId: "cust-1",
        orderId: "ord-new",
        holdReason: null,
        items: [],
      });
      const out = await (service as any).captureInTx(tx, INPUT, OPERATOR);
      expect(out).toMatchObject({ replayed: true });
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("the same returnKey already used for ANOTHER order is a 409, never a silent replay", async () => {
      prisma.return.findFirst.mockResolvedValueOnce({
        id: "ret-other",
        customerId: "cust-1",
        orderId: "some-other-order",
        holdReason: null,
        items: [],
      });
      await expect((service as any).captureInTx(tx, INPUT, OPERATOR)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("a cancelled carrying order is refused", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-new",
        customerId: "cust-1",
        total: 100,
        status: "CANCELLED",
        routeRunId: null,
      });
      await expect((service as any).captureInTx(tx, INPUT, OPERATOR)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("a DRIVER's ownership is checked against the run the caller supplies when the order row has none yet (a new order links its run after the tx)", async () => {
      await expect(
        (service as any).captureInTx(tx, { ...INPUT, routeRunStopId: "stop-1" }, DRIVER, {
          orderRouteRunId: "run-1",
        }),
      ).resolves.toMatchObject({ replayed: false });
      await expect(
        (service as any).captureInTx(tx, { ...INPUT, routeRunStopId: "stop-1" }, DRIVER),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("captureAndIssueInTx", () => {
    it("issues the credit in the SAME tx at the pre-reserved number: mint, guarded link, orderCreditNote, settle", async () => {
      const out = await (service as any).captureAndIssueInTx(tx, INPUT, OPERATOR, {
        creditNoteNumber: "CN-2026-0042",
      });
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ customerId: "cust-1", amount: 30 }),
        "CN-2026-0042",
        "test-tenant",
      );
      expect(prisma.return.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "ret-1", status: "RECEIVED", creditNoteId: null }),
          data: expect.objectContaining({ creditNoteId: "cn-1", status: "REFUNDED" }),
        }),
      );
      expect(prisma.orderCreditNote.create).toHaveBeenCalledWith({
        data: { orderId: "ord-new", creditNoteId: "cn-1", amount: 30 },
      });
      expect(creditNotes.settleOrderCreditsInTx).toHaveBeenCalledWith(tx, "ord-new", "test-tenant");
      expect(out.minted).toMatchObject({ id: "cn-1" });
      // The reserved number is used as-is: nothing reserves a second CREDIT_NOTE number in the tx.
      expect(numbering.reserveNext).not.toHaveBeenCalledWith("CREDIT_NOTE", expect.anything());
    });

    it("without a reserved number it reserves one on the tx (the edit path has no retry loop)", async () => {
      numbering.reserveNext.mockImplementation(async (type: string) =>
        type === "CREDIT_NOTE" ? "CN-2026-0099" : "RET-2026-0001",
      );
      await (service as any).captureAndIssueInTx(tx, INPUT, OPERATOR, {});
      expect(numbering.reserveNext).toHaveBeenCalledWith(
        "CREDIT_NOTE",
        expect.objectContaining({ tx }),
      );
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
        tx,
        expect.anything(),
        "CN-2026-0099",
        "test-tenant",
      );
    });

    it("caps the orderCreditNote intent at the order balance (total minus credits already applied); the CN itself is minted in full, the remainder stays on account", async () => {
      // Order total 100, $60 already applied to it: balance 40. The return is $70.
      prisma.orderCreditNote.aggregate.mockResolvedValue({ _sum: { amount: 60 } });
      const out = await (service as any).captureAndIssueInTx(tx, INPUT, OPERATOR, {
        creditNoteNumber: "CN-2026-0042",
      });
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ amount: 30 }),
        "CN-2026-0042",
        "test-tenant",
      );
      expect(prisma.orderCreditNote.create).toHaveBeenCalledWith({
        data: { orderId: "ord-new", creditNoteId: "cn-1", amount: 30 },
      });
      expect(out.minted).toMatchObject({ id: "cn-1" });
      // A bigger return is capped at the balance, never above it.
      quote.priceInlineReturn.mockResolvedValue(priced(70));
      prisma.return.updateMany.mockClear();
      prisma.orderCreditNote.create.mockClear();
      await (service as any).captureAndIssueInTx(
        tx,
        { ...INPUT, returnKey: "attempt-2" },
        OPERATOR,
        {
          creditNoteNumber: "CN-2026-0043",
        },
      );
      expect(prisma.orderCreditNote.create).toHaveBeenCalledWith({
        data: { orderId: "ord-new", creditNoteId: "cn-1", amount: 40 },
      });
    });

    it("writes no orderCreditNote intent when the order has no balance left, but still mints the credit", async () => {
      prisma.orderCreditNote.aggregate.mockResolvedValue({ _sum: { amount: 100 } });
      const out = await (service as any).captureAndIssueInTx(tx, INPUT, OPERATOR, {
        creditNoteNumber: "CN-2026-0042",
      });
      expect(out.minted).toMatchObject({ id: "cn-1" });
      expect(prisma.orderCreditNote.create).not.toHaveBeenCalled();
      expect(prisma.return.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ creditNoteId: "cn-1" }) }),
      );
    });

    it("the standalone path keeps its full-amount intent (unchanged)", async () => {
      // #2144: capture() re-reads the issued row and refuses a null read-back.
      prisma.return.findUnique.mockResolvedValue({ id: "ret-1", creditNoteId: "cn-1", items: [] });
      await (service as any).capture(
        { ...INPUT, items: [{ productId: "prod-1", qty: 6 }] },
        OPERATOR,
      );
      expect(prisma.orderCreditNote.aggregate).not.toHaveBeenCalled();
    });

    it("DRIVER_CAP hold: NO credit note, no orderCreditNote, no settle, no restock; the hold is audited", async () => {
      // Order gross is 20 and the driver's return prices at 30: held.
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-new",
        customerId: "cust-1",
        total: 20,
        status: "PENDING",
        routeRunId: "run-1",
      });
      const out = await (service as any).captureAndIssueInTx(
        tx,
        { ...INPUT, routeRunStopId: "stop-1" },
        DRIVER,
        { creditNoteNumber: "CN-2026-0042" },
      );
      expect(out.overCap).toBe(true);
      expect(out.minted).toBeNull();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.orderCreditNote.create).not.toHaveBeenCalled();
      expect(creditNotes.settleOrderCreditsInTx).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: "inline_return.driver_cap_hold" }),
        }),
      );
    });

    it("a replay issues nothing new: the credit already exists (one credit per returnKey)", async () => {
      prisma.return.findFirst.mockResolvedValueOnce({
        id: "ret-old",
        customerId: "cust-1",
        orderId: "ord-new",
        holdReason: null,
        creditNoteId: "cn-old",
        status: "REFUNDED",
        items: [],
      });
      const out = await (service as any).captureAndIssueInTx(tx, INPUT, OPERATOR, {});
      expect(out).toMatchObject({ replayed: true, minted: null });
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("a zero-total return mints no credit note and writes no intent, even with a reserved number (SA-261: the number is burned, knowingly)", async () => {
      quote.priceInlineReturn.mockResolvedValue(priced(0));
      const out = await (service as any).captureAndIssueInTx(tx, INPUT, OPERATOR, {
        creditNoteNumber: "CN-2026-0042",
      });
      expect(out.minted).toBeNull();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.orderCreditNote.create).not.toHaveBeenCalled();
      expect(creditNotes.settleOrderCreditsInTx).not.toHaveBeenCalled();
      // The Return itself is still recorded (RECEIVED, nothing to credit): it only never links a CN.
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("preflightCapture (Opus R1: refuse BEFORE anything commits outside the tx)", () => {
    it("a returnKey already used for ANOTHER order is a 409, before any pricing", async () => {
      prisma.return.findFirst.mockResolvedValueOnce({
        customerId: "cust-1",
        orderId: "some-other-order",
      });
      await expect(
        (service as any).preflightCapture(INPUT, OPERATOR, { routeRunId: null }),
      ).rejects.toThrow(ConflictException);
      expect(quote.priceInlineReturn).not.toHaveBeenCalled();
    });

    it("a replay of THIS return returns without pricing (the in-tx check hands back the existing row)", async () => {
      prisma.return.findFirst.mockResolvedValueOnce({ customerId: "cust-1", orderId: "ord-new" });
      await expect(
        (service as any).preflightCapture(INPUT, OPERATOR, { routeRunId: null }),
      ).resolves.toBeNull(); // null = replay: the caller reserves no credit-note number
      expect(quote.priceInlineReturn).not.toHaveBeenCalled();
    });

    it("dry-runs the SAME pricing engine on the plain client, never a tx, and writes nothing", async () => {
      await (service as any).preflightCapture(INPUT, OPERATOR, { routeRunId: null });
      expect(quote.priceInlineReturn).toHaveBeenCalledWith(
        {
          customerId: "cust-1",
          items: INPUT.items,
          routeRunStopId: undefined,
          sourceOrderId: undefined,
        },
        OPERATOR,
        expect.anything(),
        // #2178: no revert follows here, so nothing is excluded; SA-740: the carrying order is the walk-in's default source
        { excludeInvoiceIds: [], defaultSourceOrderId: INPUT.orderId },
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("a pricing refusal (a stale quote, an unmatchable line) surfaces now, so the caller never commits its revert", async () => {
      quote.priceInlineReturn.mockRejectedValue(new ConflictException("stale quote"));
      await expect(
        (service as any).preflightCapture(INPUT, OPERATOR, { routeRunId: null }),
      ).rejects.toThrow(ConflictException);
    });

    it("a DRIVER without a stop, or whose stop is on another run, is refused before any commit", async () => {
      await expect(
        (service as any).preflightCapture(INPUT, DRIVER, { routeRunId: "run-1" }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        (service as any).preflightCapture({ ...INPUT, routeRunStopId: "stop-1" }, DRIVER, {
          routeRunId: "run-OTHER",
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        (service as any).preflightCapture({ ...INPUT, routeRunStopId: "stop-1" }, DRIVER, {
          routeRunId: "run-1",
        }),
      ).resolves.not.toBeNull();
    });

    it("returns the dry-run total so the caller reserves a number only for a return above $0", async () => {
      quote.priceInlineReturn.mockResolvedValue({ total: 42, chunks: [] });
      await expect(
        (service as any).preflightCapture(INPUT, OPERATOR, { routeRunId: null }),
      ).resolves.toBe(42);
    });
  });

  describe("the guards run before any read (buyer / add-on)", () => {
    it("assertInlineReturnAllowed refuses a CUSTOMER before any DB read", async () => {
      await expect((service as any).assertInlineReturnAllowed(CUSTOMER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(addon.hasAddon).not.toHaveBeenCalled();
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
    });

    it("assertInlineReturnAllowed fails closed without the orders_inline_returns grant", async () => {
      addon.hasAddon.mockResolvedValue(false);
      await expect((service as any).assertInlineReturnAllowed(OPERATOR)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("assertInlineReturnAllowed passes a granted staff caller", async () => {
      await expect((service as any).assertInlineReturnAllowed(OPERATOR)).resolves.toBeUndefined();
    });
  });
});
