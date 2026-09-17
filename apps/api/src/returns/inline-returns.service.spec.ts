/**
 * Returns Inside Order Creation — PR-1c: `InlineReturnsService` (capture/issue/approve/
 * reject/cancel). Pricing itself is NOT re-tested here — `priceInlineReturn` is stubbed with
 * a hand-derived `QuoteBreakdown` per test (pricing math lives in
 * `inline-returns-pricing.spec.ts` / `inline-returns-quote.service.spec.ts`) — these tests
 * exercise capture's locking/claim/restock/ledger/audit/issue wiring and the N-1/N-2/N-5/m-1/
 * m-2/m-5 mechanisms with concrete dollar oracles.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
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

const OPERATOR: JwtPayload = {
  sub: "user-op-1",
  role: "OPERATOR",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

const DRIVER: JwtPayload = {
  sub: "user-drv-1",
  role: "DRIVER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "driver1",
  status: "ACTIVE",
} as JwtPayload;

const CUSTOMER: JwtPayload = {
  sub: "user-cust-1",
  role: "CUSTOMER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "harbor_cafe",
  status: "ACTIVE",
} as JwtPayload;

/** A minimal, hand-priced QuoteBreakdown — one matched chunk, $30.00 total. */
function priced(total = 30, subtotal = 28, taxAmount = 2, categoryTax = 0) {
  return {
    chunks: [
      {
        sourceOrderId: "src-order-1",
        sourceInvoiceItemId: "invitem-1",
        sourceOrderItemId: "orderitem-1",
        productId: "prod-1",
        pieces: 6,
        subtotal,
        taxAmount,
        categoryTax,
        priceSource: "SOURCE_INVOICE" as const,
        unitPrice: subtotal / 6,
      },
    ],
    subtotal,
    taxAmount,
    categoryTax,
    total,
    productBreakdown: {},
  };
}

const CAPTURE_DTO = {
  customerId: "cust-1",
  orderId: "ord-carrying",
  items: [{ productId: "prod-1", qty: 6 }],
  returnKey: "nonce-1",
};

describe("InlineReturnsService", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let quoteService: { priceInlineReturn: jest.Mock };
  let creditNotes: {
    mintStandaloneInTx: jest.Mock;
    settleOrderCreditsInTx: jest.Mock;
    cancelStandaloneInTx: jest.Mock;
  };
  let ledger: { reverseReturnEntries: jest.Mock; unreverseReturnEntries: jest.Mock };
  let addonService: { hasAddon: jest.Mock };
  let gateway: { emitCreditNoteCreated: jest.Mock };
  let numbering: { reserveNext: jest.Mock };
  let idempotency: { acquireLock: jest.Mock; hashFor: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    quoteService = { priceInlineReturn: jest.fn().mockResolvedValue(priced()) };
    creditNotes = {
      mintStandaloneInTx: jest.fn().mockResolvedValue({
        id: "cn-1",
        creditNoteNumber: "CN-0001",
        customerId: "cust-1",
        amount: 30,
      }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
      cancelStandaloneInTx: jest.fn().mockResolvedValue({ restored: 30 }),
    };
    ledger = {
      reverseReturnEntries: jest.fn().mockResolvedValue(undefined),
      unreverseReturnEntries: jest.fn().mockResolvedValue(undefined),
    };
    addonService = { hasAddon: jest.fn().mockResolvedValue(true) };
    gateway = { emitCreditNoteCreated: jest.fn() };
    numbering = { reserveNext: jest.fn().mockResolvedValue("RET-2026-0001") };
    idempotency = {
      acquireLock: jest.fn().mockResolvedValue(undefined),
      hashFor: jest.fn(
        (key: string, tenantId: string | null, scope: string) => `${tenantId}:${scope}:${key}`,
      ),
    };

    prisma.order.findFirst.mockResolvedValue({
      id: "ord-carrying",
      customerId: "cust-1",
      total: 1000,
    });
    // Default: every claim (the N-1 guarded link, approve's hold claim, reject's claim,
    // cancel's claim) wins. Tests that specifically drive a lost claim override this.
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.create.mockImplementation(async ({ data }: any) => ({
      id: "ret-1",
      ...data,
      items: (data.items?.create ?? []).map((i: any, idx: number) => ({ id: `ri-${idx}`, ...i })),
    }));
    // Default findFirst: no returnKey replay match, and issueCredit's two reads of "ret-1"
    // (the unlocked m-2 pre-read, then the in-tx FOR-UPDATE re-read) both see it sitting
    // RECEIVED with no credit note yet — i.e. exactly what capture()'s own `return.create`
    // mock above just produced. Individual tests override this with `mockResolvedValueOnce`
    // chains (which take priority) to drive a specific race/replay scenario.
    prisma.return.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.id === "ret-1" || where?.id === "ret-held") {
        return {
          id: where.id,
          kind: "INLINE",
          status: "RECEIVED",
          holdReason: null,
          heldAmount: null,
          creditNoteId: null,
          customerId: "cust-1",
          orderId: "ord-carrying",
          returnNumber: "RET-2026-0001",
          creditSubtotal: 28,
          creditTax: 2,
          creditCategoryTax: 0,
        };
      }
      return null;
    });

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: RegulatedLedgerService, useValue: ledger },
        { provide: CreditNotesService, useValue: creditNotes },
        { provide: NumberingService, useValue: numbering },
        { provide: AddonService, useValue: addonService },
        { provide: InlineReturnsQuoteService, useValue: quoteService },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  // ─── grant check + CUSTOMER refusal ─────────────────────────────────────────

  it("refuses a CUSTOMER caller before any DB read", async () => {
    await expect(service.capture(CAPTURE_DTO as any, CUSTOMER)).rejects.toThrow(ForbiddenException);
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
    expect(addonService.hasAddon).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the tenant lacks the orders_inline_returns grant, regardless of registry state", async () => {
    addonService.hasAddon.mockResolvedValue(false);
    await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toThrow(ForbiddenException);
    expect(prisma.order.findFirst).not.toHaveBeenCalled();
  });

  // ─── happy path: capture + immediate issue ──────────────────────────────────

  it("captures, restocks, reverses the ledger, and issues a $30.00 standalone credit note — one commit each", async () => {
    const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

    expect(prisma.return.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "INLINE",
          status: "RECEIVED",
          orderId: "ord-carrying",
        }),
      }),
    );
    // restockReturnItems: one StockMovement + one Product increment for the single item.
    expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentStock: { increment: expect.anything() } } }),
    );
    // Ledger reversal keyed to the SOURCE order, not the carrying order.
    expect(ledger.reverseReturnEntries).toHaveBeenCalledWith(
      expect.objectContaining({ returnId: "ret-1", orderId: "src-order-1" }),
    );
    // m-1: mints the priced total (§3.3 total = subtotal+tax+categoryTax).
    expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerId: "cust-1", amount: 30 }),
      expect.any(String),
      "test-tenant",
    );
    // N-1 guarded link: the return is REFUNDED with the minted CN attached.
    expect(prisma.return.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "ret-1", status: "RECEIVED", creditNoteId: null }),
        data: expect.objectContaining({
          creditNoteId: "cn-1",
          status: "REFUNDED",
          refundAmount: 30,
        }),
      }),
    );
    // §2.1/§6.3: the system-owned intent.
    expect(prisma.orderCreditNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: "ord-carrying", creditNoteId: "cn-1" }),
      }),
    );
    expect(creditNotes.settleOrderCreditsInTx).toHaveBeenCalled();
    // Emitted only AFTER the issue transaction, never from inside it.
    expect(gateway.emitCreditNoteCreated).toHaveBeenCalledWith(
      "test-tenant",
      expect.objectContaining({ creditNoteId: "cn-1", amount: 30 }),
    );
    expect(result).toBeDefined();
  });

  it("resolves restock from the reason default (DAMAGED never restocks) when the item omits an explicit flag", async () => {
    quoteService.priceInlineReturn.mockResolvedValue(priced());
    await service.capture({ ...CAPTURE_DTO, reason: "DAMAGED" } as any, OPERATOR);

    const created = prisma.return.create.mock.calls[0][0].data;
    expect(created.items.create[0].restock).toBe(false);
    // Nothing restocked ⇒ no StockMovement for this item.
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  // ─── N-2 / m-3: returnKey replay ─────────────────────────────────────────────

  it("m-3/N-2: a returnKey already captured is replayed — no second create, no second movement (revert ⇒ duplicate insert)", async () => {
    const existing = { id: "ret-existing", returnKey: "nonce-1", kind: "INLINE", items: [] };
    prisma.return.findFirst.mockResolvedValueOnce(existing); // the pre-tx unlocked read

    const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

    expect(result).toBe(existing);
    expect(prisma.return.create).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
  });

  // ─── N-5: driver cap — second return over the carrying order's gross is held whole ──

  it("N-5: a DRIVER capture that would push Σ over the order's gross is held whole — no CN minted", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-carrying",
      customerId: "cust-1",
      total: 30,
    });
    // Σ already on the order: $25.00 issued from a prior inline return.
    prisma.return.findMany.mockResolvedValue([{ refundAmount: 25, heldAmount: null }]);
    quoteService.priceInlineReturn.mockResolvedValue(priced(10, 10, 0, 0)); // $10 more ⇒ Σ would be $35 > $30 gross

    const result = await service.capture(
      { ...CAPTURE_DTO, returnKey: "nonce-driver" } as any,
      DRIVER,
    );

    expect(prisma.return.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ holdReason: "DRIVER_CAP", heldAmount: 10 }),
      }),
    );
    // Held whole: the goods ARE restocked/reversed (captured), but no credit is minted.
    expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    // §4: in-tx audit row for the hold.
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "inline_return.driver_cap_hold",
          entityId: "ret-1",
        }),
      }),
    );
    expect(result.holdReason).toBe("DRIVER_CAP");
  });

  it("N-5: an OPERATOR capture is NEVER driver-capped, even over the same order's gross", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-carrying",
      customerId: "cust-1",
      total: 5,
    });
    prisma.return.findMany.mockResolvedValue([{ refundAmount: 25, heldAmount: null }]);
    quoteService.priceInlineReturn.mockResolvedValue(priced(10, 10, 0, 0));

    await service.capture({ ...CAPTURE_DTO, returnKey: "nonce-op" } as any, OPERATOR);

    expect(creditNotes.mintStandaloneInTx).toHaveBeenCalled();
  });

  // ─── N-1: cancel racing between the re-read and the link ────────────────────

  it("N-1: a return that moved out of RECEIVED between issueCredit's lock and the mint mints NOTHING (revert ⇒ orphaned CN)", async () => {
    // The unlocked pre-read (m-2) still sees RECEIVED — issueCredit proceeds to open its tx.
    prisma.return.findFirst
      .mockResolvedValueOnce(null) // capture()'s own pre-tx replay check
      .mockResolvedValueOnce(null) // capture()'s in-tx replay check (kind INLINE) — none found, proceeds to create
      .mockResolvedValueOnce({
        id: "ret-1",
        status: "RECEIVED",
        creditNoteId: null,
        customerId: "cust-1",
        orderId: "ord-carrying",
        creditSubtotal: 28,
        creditTax: 2,
        creditCategoryTax: 0,
      }) // issueCredit's own unlocked pre-read (m-2) — carries the priced amount ($30) so it clears the amount>0 gate and actually opens the tx
      .mockResolvedValueOnce({ id: "ret-1", status: "CANCELLED", creditNoteId: null }); // issueCredit's in-tx FOR-UPDATE re-read: cancel() won the race

    await service.capture(CAPTURE_DTO as any, OPERATOR);

    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ creditNoteId: expect.anything() }),
      }),
    );
  });

  // ─── approve / reject (N-5, Q-C) ─────────────────────────────────────────────

  describe("approve", () => {
    const HELD: any = {
      id: "ret-held",
      kind: "INLINE",
      status: "RECEIVED",
      holdReason: "DRIVER_CAP",
      heldAmount: 40,
      creditNoteId: null,
      customerId: "cust-1",
      orderId: "ord-carrying",
      creditSubtotal: 40,
      creditTax: 0,
      creditCategoryTax: 0,
      returnNumber: "RET-1",
    };

    it("approves the full held amount and mints exactly one credit note", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.approve("ret-held", OPERATOR);

      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: 40 }),
        expect.any(String),
        "test-tenant",
      );
    });

    it("approves a REDUCED amount when given one", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.approve("ret-held", OPERATOR, { amount: 15 });

      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: 15 }),
        expect.any(String),
        "test-tenant",
      );
    });

    it("refuses an amount above the held credit", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      await expect(service.approve("ret-held", OPERATOR, { amount: 999 })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("a retried/duplicate approve (claim matches 0 rows) mints NO second credit note — revert ⇒ two CNs", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      // The claim itself loses (a concurrent approve already won it).
      prisma.return.updateMany.mockResolvedValue({ count: 0 });

      await service.approve("ret-held", OPERATOR);

      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("refuses a return that isn't a driver-cap hold", async () => {
      prisma.return.findFirst.mockResolvedValue({ ...HELD, holdReason: null });
      await expect(service.approve("ret-held", OPERATOR)).rejects.toThrow(BadRequestException);
    });

    it("404s a missing return", async () => {
      prisma.return.findFirst.mockResolvedValue(null);
      await expect(service.approve("nope", OPERATOR)).rejects.toThrow(NotFoundException);
    });
  });

  describe("reject", () => {
    it("declines a driver-cap hold — REJECTED, no credit note ever minted", async () => {
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.reject("ret-held", OPERATOR);
      expect(prisma.return.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }),
      );
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("refuses when there is nothing to reject (claim matches 0 rows)", async () => {
      prisma.return.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reject("ret-held", OPERATOR)).rejects.toThrow(BadRequestException);
    });
  });

  // ─── cancel (m-5) ─────────────────────────────────────────────────────────────

  describe("cancel", () => {
    it("a PENDING (never-captured) return writes NO stock movement on cancel — revert ⇒ phantom restock", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-pending",
        status: "PENDING",
        holdReason: "CAPTURE_PENDING",
        items: [{ productId: "prod-1", qty: 6, restock: true }],
        orderId: "ord-carrying",
        creditNoteId: null,
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel("ret-pending", OPERATOR);

      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockMovement.deleteMany).not.toHaveBeenCalled();
      expect(ledger.unreverseReturnEntries).not.toHaveBeenCalled();
    });

    it("a RECEIVED (captured, not yet issued) return unrestocks + unreverses on cancel", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-received",
        status: "RECEIVED",
        items: [{ productId: "prod-1", qty: 6, restock: true }],
        orderId: "ord-carrying",
        creditNoteId: null,
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel("ret-received", OPERATOR);

      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { currentStock: { decrement: 6 } } }),
      );
      expect(prisma.stockMovement.deleteMany).toHaveBeenCalled();
      expect(ledger.unreverseReturnEntries).toHaveBeenCalledWith(
        expect.objectContaining({ returnId: "ret-received" }),
      );
      expect(creditNotes.cancelStandaloneInTx).not.toHaveBeenCalled();
    });

    it("a REFUNDED return unrestocks + unreverses + pulls back and voids its OWN credit note, then deletes the intent — revert ⇒ no pull-back", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-refunded",
        status: "REFUNDED",
        items: [{ productId: "prod-1", qty: 6, restock: true }],
        orderId: "ord-carrying",
        creditNoteId: "cn-1",
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel("ret-refunded", OPERATOR);

      expect(creditNotes.cancelStandaloneInTx).toHaveBeenCalledWith(expect.anything(), "cn-1");
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderId: "ord-carrying", creditNoteId: "cn-1" } }),
      );
    });

    it("refuses cancelling an already-cancelled return", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-x",
        status: "CANCELLED",
        items: [],
        orderId: "ord-carrying",
        creditNoteId: null,
      });
      prisma.return.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.cancel("ret-x", OPERATOR)).rejects.toThrow(BadRequestException);
    });
  });
});
