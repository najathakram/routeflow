/**
 * Returns Inside Order Creation — PR-1c: `InlineReturnsService` (capture/issue/approve/
 * reject/cancel). Pricing itself is NOT re-tested here — `priceInlineReturn` is stubbed with
 * a hand-derived `QuoteBreakdown` per test (pricing math lives in
 * `inline-returns-pricing.spec.ts` / `inline-returns-quote.service.spec.ts`) — these tests
 * exercise capture's locking/claim/restock/ledger/audit/issue wiring and the N-1/N-2/N-5/m-1/
 * m-2/m-5 mechanisms with concrete dollar oracles, plus the Opus review (BLOCK) fix round's
 * HIGH-1/2/4, MED-5/6/7 mechanisms.
 */
import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
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

const DRIVER_CAPTURE_DTO = { ...CAPTURE_DTO, routeRunStopId: "stop-1", returnKey: "nonce-driver" };

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
      // Echoes back the requested amount/customer so a test that mints a DIFFERENT amount
      // (a reduced approval) sees the matching figure on the returned `minted` row too —
      // that's what `emitCreditNoteCreated` reads (`Number(minted.amount)`).
      mintStandaloneInTx: jest.fn((_tx: any, dto: any) =>
        Promise.resolve({
          id: "cn-1",
          creditNoteNumber: "CN-0001",
          customerId: dto.customerId,
          amount: dto.amount,
        }),
      ),
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
      status: "PENDING",
      routeRunId: "run-1",
    });
    prisma.routeRunStop.findFirst.mockResolvedValue({ routeRunId: "run-1" });
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
          items: [{ productId: "prod-1", qty: 6, restock: true }],
        };
      }
      return null;
    });
    // sumInlineReturnCredit's own query — empty by default (no prior committed credit).
    prisma.return.findMany.mockResolvedValue([]);
    // The final "read back the row" call at the end of capture()/approve() — a realistic
    // stand-in so a test that doesn't care about the exact returned shape still gets a
    // truthy object back instead of the mock's bare `null` default.
    prisma.return.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      status: "REFUNDED",
      creditNoteId: "cn-1",
    }));

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

  it("m-3/N-2: a returnKey already captured (and already issued) is replayed — no second create, no second movement (revert ⇒ duplicate insert)", async () => {
    const existing = {
      id: "ret-existing",
      returnKey: "nonce-1",
      kind: "INLINE",
      customerId: "cust-1",
      orderId: "ord-carrying",
      status: "REFUNDED",
      creditNoteId: "cn-existing",
      holdReason: null,
      items: [],
    };
    prisma.return.findFirst.mockResolvedValueOnce(existing); // the pre-tx unlocked read

    const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

    expect(result).toBe(existing);
    expect(prisma.return.create).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
  });

  it("HIGH-2: a returnKey replay of a STUCK row (RECEIVED, no CN, no hold — a prior issueCredit failed after capture committed) re-issues idempotently", async () => {
    const stuck = {
      id: "ret-stuck",
      returnKey: "nonce-1",
      kind: "INLINE",
      customerId: "cust-1",
      orderId: "ord-carrying",
      status: "RECEIVED",
      creditNoteId: null,
      holdReason: null,
      returnNumber: "RET-STUCK",
      creditSubtotal: 28,
      creditTax: 2,
      creditCategoryTax: 0,
      items: [],
    };
    // Pre-tx replay read finds the stuck row; the shared findFirst impl below (id "ret-stuck")
    // backs issueCredit's own two reads.
    prisma.return.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.returnKey === "nonce-1" || where?.id === "ret-stuck") return stuck;
      return null;
    });

    await service.capture(CAPTURE_DTO as any, OPERATOR);

    expect(prisma.return.create).not.toHaveBeenCalled(); // never re-captures
    expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customerId: "cust-1", amount: 30 }),
      expect.any(String),
      expect.anything(),
    );
    expect(prisma.return.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "REFUNDED", creditNoteId: "cn-1" }),
      }),
    );
  });

  it("a returnKey belonging to a DIFFERENT customer/order (found only at the PRE-tx check, gone by the in-tx re-check) is never treated as a replay", async () => {
    prisma.return.findFirst.mockResolvedValueOnce({
      id: "ret-other",
      returnKey: "nonce-1",
      kind: "INLINE",
      customerId: "cust-OTHER",
      orderId: "ord-OTHER",
      status: "REFUNDED",
      items: [],
    });

    // Falls through to a real capture attempt (the in-tx re-check below reverts to the
    // beforeEach default, which finds no match for this returnKey) rather than
    // short-circuiting as a replay of someone else's return.
    const result = await service.capture(CAPTURE_DTO as any, OPERATOR);
    expect(prisma.return.create).toHaveBeenCalled();
    expect(result.id).toBe("ret-1");
  });

  it("MED-7 (re-review): the SAME mismatch, found only by the IN-TX re-check (a racer committed it while this call waited for the lock), also throws 409 — revert ⇒ silent replay", async () => {
    prisma.return.findFirst
      .mockResolvedValueOnce(null) // pre-tx check: no match yet, proceeds to open the tx
      .mockResolvedValueOnce({
        id: "ret-other",
        returnKey: "nonce-1",
        kind: "INLINE",
        customerId: "cust-OTHER",
        orderId: "ord-OTHER",
        status: "REFUNDED",
        items: [],
      }); // the IN-TX re-check, after the row lock, finds the racer's mismatched row

    await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toThrow(ConflictException);
    expect(prisma.return.create).not.toHaveBeenCalled();
  });

  // ─── MED-7: P2002 returnKey collision outside the aborted transaction ───────

  describe("MED-7: returnKey P2002 collision", () => {
    it("catches the conflict OUTSIDE the aborted transaction and replays when the raced row matches this (customerId, orderId)", async () => {
      prisma.tenantTransaction.mockImplementationOnce(async () => {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        err.meta = { target: ["tenantId", "returnKey"] };
        throw err;
      });
      const raced = {
        id: "ret-raced",
        returnKey: "nonce-1",
        kind: "INLINE",
        customerId: "cust-1",
        orderId: "ord-carrying",
        status: "REFUNDED",
        creditNoteId: "cn-raced",
        holdReason: null,
        items: [],
      };
      prisma.return.findFirst.mockResolvedValueOnce(null); // pre-tx check: no replay yet
      // POST-catch lookup (a fresh, non-aborted read) finds the racer's committed row.
      prisma.return.findFirst.mockResolvedValueOnce(raced);

      const result = await service.capture(CAPTURE_DTO as any, OPERATOR);
      expect(result).toBe(raced);
    });

    it("throws a 409 Conflict (never a raw P2002) when the raced row belongs to someone else", async () => {
      prisma.tenantTransaction.mockImplementationOnce(async () => {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        err.meta = { target: ["tenantId", "returnKey"] };
        throw err;
      });
      prisma.return.findFirst.mockResolvedValueOnce(null);
      prisma.return.findFirst.mockResolvedValueOnce({
        id: "ret-raced",
        customerId: "cust-OTHER",
        orderId: "ord-OTHER",
        kind: "INLINE",
        items: [],
      });

      await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toThrow(
        ConflictException,
      );
    });

    it("a P2002 on an UNRELATED constraint is never mistaken for a returnKey replay", async () => {
      prisma.tenantTransaction.mockImplementationOnce(async () => {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        err.meta = { target: ["someOtherColumn"] };
        throw err;
      });
      await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toMatchObject({
        code: "P2002",
      });
    });
  });

  // ─── N-5: driver cap — second return over the carrying order's gross is held whole ──

  describe("N-5: driver cap", () => {
    it("HIGH-4: a DRIVER capture that would push Σ over the order's gross is held whole — NO restock/ledger reversal/CN yet", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 30,
        status: "PENDING",
        routeRunId: "run-1",
      });
      // HIGH-1: Σ already committed on the order — $25.00 from a prior RECEIVED/REFUNDED
      // inline return, visible via creditSubtotal/Tax/CategoryTax (never refundAmount/
      // heldAmount, which is exactly the blind spot HIGH-1 fixed).
      prisma.return.findMany.mockResolvedValue([
        { creditSubtotal: 25, creditTax: 0, creditCategoryTax: 0 },
      ]);
      quoteService.priceInlineReturn.mockResolvedValue(priced(10, 10, 0, 0)); // $10 more ⇒ Σ would be $35 > $30 gross

      const result = await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);

      expect(prisma.return.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ holdReason: "DRIVER_CAP", heldAmount: 10 }),
        }),
      );
      // HIGH-4: held whole means NOTHING is applied yet — no restock, no ledger reversal, no
      // credit note — all deferred to approve().
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
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
        status: "PENDING",
        routeRunId: "run-1",
      });
      prisma.return.findMany.mockResolvedValue([
        { creditSubtotal: 25, creditTax: 0, creditCategoryTax: 0 },
      ]);
      quoteService.priceInlineReturn.mockResolvedValue(priced(10, 10, 0, 0));

      await service.capture({ ...CAPTURE_DTO, returnKey: "nonce-op" } as any, OPERATOR);

      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalled();
    });

    it("HIGH-1: two parallel DRIVER captures both see the FIRST's committed credit via creditSubtotal (visible even before it's issued) — the second is held", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 20,
        status: "PENDING",
        routeRunId: "run-1",
      });
      // The first capture committed RECEIVED with no hold and no CN yet (mid capture→issue
      // gap) — HIGH-1's fix makes this visible to Σ via creditSubtotal alone.
      prisma.return.findMany.mockResolvedValue([
        { creditSubtotal: 15, creditTax: 0, creditCategoryTax: 0 },
      ]);
      quoteService.priceInlineReturn.mockResolvedValue(priced(10, 10, 0, 0)); // 15 + 10 = 25 > 20 gross

      const result = await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);
      expect(result.holdReason).toBe("DRIVER_CAP");
    });

    it("re-review LOW-MED: a zero-total DRIVER capture is NEVER held, even when Σ already exceeds the order's gross on its own", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 5, // tiny gross
        status: "PENDING",
        routeRunId: "run-1",
      });
      // Σ ALREADY over the gross before this return even prices anything.
      prisma.return.findMany.mockResolvedValue([
        { creditSubtotal: 10, creditTax: 0, creditCategoryTax: 0 },
      ]);
      quoteService.priceInlineReturn.mockResolvedValue(priced(0, 0, 0, 0)); // this return's own total is $0.00

      const result = await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);

      expect(prisma.return.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ holdReason: "DRIVER_CAP" }),
        }),
      );
      // Not held ⇒ restock/ledger reversal run immediately, same as any non-held capture.
      expect(ledger.reverseReturnEntries).toHaveBeenCalled();
      expect(result.holdReason ?? null).toBeNull();
    });
  });

  // ─── MED-5: a DRIVER may only capture on their own current route run ────────

  describe("MED-5: driver/order ownership", () => {
    it("refuses a DRIVER capture with no routeRunStopId", async () => {
      await expect(service.capture(CAPTURE_DTO as any, DRIVER)).rejects.toThrow(ForbiddenException);
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("refuses a DRIVER capture whose order is NOT on the stop's route run", async () => {
      prisma.routeRunStop.findFirst.mockResolvedValue({ routeRunId: "run-OTHER" });
      await expect(service.capture(DRIVER_CAPTURE_DTO as any, DRIVER)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("refuses capturing against a CANCELLED order for any role", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 1000,
        status: "CANCELLED",
        routeRunId: "run-1",
      });
      await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
    });
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
        holdReason: null,
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

  // ─── approve / reject (N-5, Q-C, HIGH-2, HIGH-4) ─────────────────────────────

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
      items: [{ productId: "prod-1", qty: 6, restock: true, sourceOrderId: "src-order-1" }],
    };

    it("HIGH-4: approving restocks + reverses the ledger NOW (deferred from capture), then mints the full held amount", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.approve("ret-held", OPERATOR);

      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { currentStock: { increment: expect.anything() } } }),
      );
      expect(ledger.reverseReturnEntries).toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ amount: 40 }),
        expect.any(String),
        "test-tenant",
      );
      expect(prisma.return.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ approvedById: OPERATOR.sub }),
        }),
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
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("re-review LOW-MED: a hold with heldAmount 0 throws BEFORE any restock or ledger reversal — use reject() instead", async () => {
      prisma.return.findFirst.mockResolvedValue({ ...HELD, heldAmount: 0 });

      await expect(service.approve("ret-held", OPERATOR)).rejects.toThrow(BadRequestException);

      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("re-review LOW-MED: an explicit approve amount of 0 (or ≤ $0.001) also throws BEFORE any restock/ledger reversal", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);

      await expect(service.approve("ret-held", OPERATOR, { amount: 0 })).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
    });

    it("HIGH-2: a retried/duplicate approve (the row lock re-read finds it already resolved) mints NO second credit note — revert ⇒ two CNs", async () => {
      // The unlocked pre-check still sees the hold (a concurrent approve hasn't landed yet)…
      prisma.return.findFirst.mockResolvedValueOnce(HELD);
      // …but by the time THIS call gets the row lock, the row has already moved on.
      prisma.return.findFirst.mockResolvedValueOnce({
        ...HELD,
        status: "REFUNDED",
        creditNoteId: "cn-other",
      });

      await service.approve("ret-held", OPERATOR);

      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
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
    it("declines a driver-cap hold — REJECTED, holdReason left AS-IS, no credit note ever minted, nothing restocked", async () => {
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.reject("ret-held", OPERATOR);
      expect(prisma.return.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ holdReason: "DRIVER_CAP" }),
          data: expect.objectContaining({ status: "REJECTED" }),
        }),
      );
      // holdReason/heldAmount must NOT be nulled here — cancel()'s "was anything applied"
      // check on a REJECTED row relies on holdReason staying "DRIVER_CAP".
      const data = prisma.return.updateMany.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("holdReason");
      expect(data).not.toHaveProperty("heldAmount");
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("refuses when there is nothing to reject (claim matches 0 rows)", async () => {
      prisma.return.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reject("ret-held", OPERATOR)).rejects.toThrow(BadRequestException);
    });
  });

  // ─── cancel (m-5, HIGH-4's "was anything applied" redefinition) ─────────────

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
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(ledger.unreverseReturnEntries).not.toHaveBeenCalled();
    });

    it("HIGH-4: a RECEIVED return STILL held (DRIVER_CAP, awaiting approval) writes NO stock on cancel — it was never applied", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-held",
        status: "RECEIVED",
        holdReason: "DRIVER_CAP",
        heldAmount: 40,
        items: [{ productId: "prod-1", qty: 6, restock: true }],
        orderId: "ord-carrying",
        creditNoteId: null,
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel("ret-held", OPERATOR);

      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(ledger.unreverseReturnEntries).not.toHaveBeenCalled();
    });

    it("HIGH-4: a REJECTED (declined-from-hold) return writes NO stock on cancel — it was never applied either", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-rejected",
        status: "REJECTED",
        holdReason: "DRIVER_CAP", // left as-is by reject() on purpose
        heldAmount: 40,
        items: [{ productId: "prod-1", qty: 6, restock: true }],
        orderId: "ord-carrying",
        creditNoteId: null,
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel("ret-rejected", OPERATOR);

      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(ledger.unreverseReturnEntries).not.toHaveBeenCalled();
    });

    it("a RECEIVED (captured, not yet issued) return unrestocks + writes a COMPENSATING movement on cancel", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-received",
        status: "RECEIVED",
        holdReason: null,
        items: [{ productId: "prod-1", qty: 6, restock: true }],
        orderId: "ord-carrying",
        creditNoteId: null,
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      // Real Prisma hands back a Decimal instance for a Decimal column — match that shape so
      // the service's `.sub()`/`.neg()` Decimal arithmetic has a real method to call.
      prisma.product.findFirst.mockResolvedValue({
        currentStock: new Prisma.Decimal(20),
        averageCost: new Prisma.Decimal(5),
      });

      await service.cancel("ret-received", OPERATOR);

      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { currentStock: { decrement: expect.anything() } } }),
      );
      // LOW: a compensating (negative-qty) movement — never a delete of the original entry.
      expect(prisma.stockMovement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            productId: "prod-1",
            reference: "RET-CANCEL-ret-rece",
          }),
        }),
      );
      expect(prisma.stockMovement.deleteMany).not.toHaveBeenCalled();
      expect(ledger.unreverseReturnEntries).toHaveBeenCalledWith(
        expect.objectContaining({ returnId: "ret-received" }),
      );
      expect(creditNotes.cancelStandaloneInTx).not.toHaveBeenCalled();
    });

    it("a REFUNDED return unrestocks + unreverses + pulls back and voids its OWN credit note, then deletes the intent — revert ⇒ no pull-back", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-refunded",
        status: "REFUNDED",
        holdReason: null,
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
