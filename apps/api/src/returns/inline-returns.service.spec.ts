/**
 * Returns Inside Order Creation — PR-1c: `InlineReturnsService` (capture/issue/approve/
 * reject/cancel). Pricing itself is NOT re-tested here — `priceInlineReturn` is stubbed with
 * a hand-derived `QuoteBreakdown` per test (pricing math lives in
 * `inline-returns-pricing.spec.ts` / `inline-returns-quote.service.spec.ts`) — these tests
 * exercise capture's locking/claim/restock/ledger/audit/issue wiring and the N-1/N-2/N-5/m-1/
 * m-2/m-5 mechanisms with concrete dollar oracles, plus the Opus review (BLOCK) fix round's
 * HIGH-1/2/4, MED-5/6/7 mechanisms.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { INLINE_RETURN_ERROR_CODES, InlineReturnsService } from "./inline-returns.service";
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

import { inlineReturnItemsFingerprint } from "./inline-return-fingerprint";

const CAPTURE_DTO = {
  customerId: "cust-1",
  orderId: "ord-carrying",
  items: [{ productId: "prod-1", qty: 6 }],
  returnKey: "nonce-1",
};

const DRIVER_CAPTURE_DTO = { ...CAPTURE_DTO, routeRunStopId: "stop-1", returnKey: "nonce-driver" };

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: any) => e?.getResponse?.()?.code ?? null,
  );

describe("InlineReturnsService", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let quoteService: { priceInlineReturn: jest.Mock };
  let creditNotes: {
    mintStandaloneInTx: jest.Mock;
    settleOrderCreditsInTx: jest.Mock;
    cancelStandaloneInTx: jest.Mock;
    cancelLockSet: jest.Mock;
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
      cancelLockSet: jest.fn().mockResolvedValue({ orderIds: [], invoiceIds: [] }),
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
    // Row 347 (1): the capture mints in its OWN transaction, so assertInlineSourcesOpen now asks about the captured chunk's source
    // line ("invitem-1") before the mint: by default it exists, on a live invoice (tests that drive a dead / lost source override).
    prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
      (where?.id?.in ?? []).includes("invitem-1")
        ? [{ id: "invitem-1", invoiceId: "inv-live" }]
        : [],
    );
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

  // ─── B735: parked reversal visibility ────────────────────────────────────────

  describe("B735: a park guard reversal must be visible on the capture/approve response", () => {
    it("REG-B735-api-capture-parked: a fresh capture with an unresolved parked reversal carries a count/pieces total", async () => {
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([
        { returnedPieces: 3 },
        { returnedPieces: 2 },
      ]);

      const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

      expect(prisma.regulatedLedgerParkedReversal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            returnId: "ret-1",
            tenantId: "test-tenant",
            resolvedAt: null,
          }),
        }),
      );
      expect((result as any).parkedReversals).toEqual({ count: 2, pieces: 5 });
    });

    // #2144 (+ #2477's first item): after capture() issues the credit, it reads the row back. A
    // null read-back used to fall back to the PRE-issue snapshot, which carries no creditNoteId —
    // a response that looks un-issued for a credit that WAS issued. Like approve() (#2467), it now
    // refuses instead; a retry with the same returnKey replays and returns the issued row.
    it("#2144: the capture response is the POST-issue row, carrying the issued creditNoteId", async () => {
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([]);
      const result = await service.capture(CAPTURE_DTO as any, OPERATOR);
      expect(result).toMatchObject({ creditNoteId: "cn-1" });
    });

    it("#2144: a null read-back after issuing never returns the stale pre-issue snapshot", async () => {
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([]);
      prisma.return.findUnique.mockResolvedValue(null);
      await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("REG-B735-api-capture-clean: a fresh capture with no parked rows carries parkedReversals: null, never undefined", async () => {
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([]);

      const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

      expect((result as any).parkedReversals).toBeNull();
    });

    it("REG-B735-api-capture-read-fails: a failed parked-reversal read after commit does not 500 the capture; the field is ABSENT, not null", async () => {
      prisma.regulatedLedgerParkedReversal.findMany.mockRejectedValue(new Error("db down"));

      const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty("parkedReversals");
    });

    it("REG-B735-api-capture-null-tenant: no tenant context (SUPER_ADMIN) omits the field and never queries", async () => {
      prisma.getTenantId.mockReturnValue(null);

      const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

      expect(result).not.toHaveProperty("parkedReversals");
      expect(prisma.regulatedLedgerParkedReversal.findMany).not.toHaveBeenCalled();
    });

    it("REG-B735-api-capture-replay-shortcircuit-parked: the pre-tx returnKey replay never calls reverseReturnEntries, but still reports an existing park", async () => {
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
      prisma.return.findFirst.mockResolvedValueOnce(existing);
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([{ returnedPieces: 4 }]);

      const result = await service.capture(CAPTURE_DTO as any, OPERATOR);

      // The whole point of a fresh read over a threaded return value: this branch never
      // calls reverseReturnEntries (it's a replay, not a fresh reversal) and would show a
      // parked capture as clean if the signal only ever came from that call's own result.
      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
      expect((result as any).parkedReversals).toEqual({ count: 1, pieces: 4 });
    });

    it("REG-B735-api-capture-overcap-null: a DRIVER_CAP hold defers the reversal to approve(), so capture's own response carries parkedReversals: null", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 30,
        status: "PENDING",
        routeRunId: "run-1",
      });
      prisma.return.findMany.mockResolvedValue([
        { creditSubtotal: 25, creditTax: 0, creditCategoryTax: 0 },
      ]);
      quoteService.priceInlineReturn.mockResolvedValue(priced(10, 10, 0, 0));
      // No park exists for THIS return — it never reached reverseReturnEntries, so nothing
      // was ever written for it. The lookup still runs (unconditionally, by design — see
      // withParkedReversals) and correctly finds nothing.
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([]);

      const result = await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);

      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
      // Proves the lookup is scoped to THIS return's own id, not a blanket "any park exists"
      // check — a park belonging to a different return must never leak into this response.
      expect(prisma.regulatedLedgerParkedReversal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ returnId: "ret-1" }) }),
      );
      expect((result as any).parkedReversals).toBeNull();
      expect((result as any).holdReason).toBe("DRIVER_CAP");
    });
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

    // B735: every capture exit now carries a fresh parkedReversals read, so a bare `toBe`
    // referential-equality check no longer holds — the response is a new wrapped object.
    expect(result).toEqual({ ...existing, parkedReversals: null });
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

  it("SA-773 N4: the replay re-issue of a STUCK return whose source invoice was voided mints nothing (409 RETURN_NOTHING_BILLED)", async () => {
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
      items: [{ productId: "prod-1", qty: 6, sourceInvoiceItemId: "line-1" }],
    };
    prisma.return.findFirst.mockImplementation(async ({ where }: any) =>
      where?.returnKey === "nonce-1" || where?.id === "ret-stuck" ? stuck : null,
    );
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "line-1", invoiceId: "inv-dead" }]);
    prisma.invoice.findFirst.mockResolvedValue({ id: "inv-dead" });

    const err: any = await service.capture(CAPTURE_DTO as any, OPERATOR).catch((e: any) => e);

    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "RETURN_NOTHING_BILLED" });
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
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

    const p = service.capture(CAPTURE_DTO as any, OPERATOR);
    await expect(p).rejects.toThrow(ConflictException);
    expect(await codeOf(p)).toBe(INLINE_RETURN_ERROR_CODES.RETURN_KEY_CONFLICT);
    expect(prisma.return.create).not.toHaveBeenCalled();
  });

  // ─── MED-7: P2002 returnKey collision outside the aborted transaction ───────

  // #2424 (tier 1): a same-key, same-(customer, order) replay used to return the stored Return
  // WITHOUT comparing items, so a second, different capture reusing the key was silently lost.
  describe("#2424: a returnKey replay must carry the same items", () => {
    const stored = (items: any[] | null, over: any = {}) => ({
      id: "ret-first",
      returnNumber: "RET-2026-0042",
      returnKey: "nonce-1",
      kind: "INLINE",
      customerId: "cust-1",
      orderId: "ord-carrying",
      status: "REFUNDED",
      creditNoteId: "cn-first",
      holdReason: null,
      capturePayload: items === null ? null : inlineReturnItemsFingerprint(items),
      items: [],
      ...over,
    });
    const DIFFERENT = { ...CAPTURE_DTO, items: [{ productId: "prod-1", qty: 9 }] };

    it("the capture stores the request items' fingerprint on the Return", async () => {
      await service.capture(CAPTURE_DTO as any, OPERATOR);
      expect(prisma.return.create.mock.calls[0][0].data.capturePayload).toEqual(
        inlineReturnItemsFingerprint(CAPTURE_DTO.items),
      );
    });

    it("pre-read replay with the SAME items ⇒ the stored Return (no new write)", async () => {
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items));
      const res: any = await service.capture(CAPTURE_DTO as any, OPERATOR);
      expect(res.id).toBe("ret-first");
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("pre-read replay with DIFFERENT items ⇒ 409 KEY_REUSED_WITH_DIFFERENT_ITEMS, nothing written", async () => {
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items));
      const p = service.capture(DIFFERENT as any, OPERATOR);
      await expect(p).rejects.toThrow(ConflictException);
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items));
      expect(await codeOf(service.capture(DIFFERENT as any, OPERATOR))).toBe(
        INLINE_RETURN_ERROR_CODES.RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
      );
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.return.create).not.toHaveBeenCalled();
      // the lead's fold (2): the body says the earlier return WAS recorded, and names it
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items));
      const body = await service
        .capture(DIFFERENT as any, OPERATOR)
        .catch((e: any) => e.getResponse());
      expect(body).toMatchObject({ returnId: "ret-first", returnNumber: "RET-2026-0042" });
      expect(body.message).toMatch(/RET-2026-0042 was already recorded/);
    });

    it("the same items in a different order are the same capture (replay)", async () => {
      const two = [
        { productId: "prod-1", qty: 6 },
        { productId: "prod-2", qty: 2 },
      ];
      prisma.return.findFirst.mockResolvedValueOnce(stored(two));
      const res: any = await service.capture(
        { ...CAPTURE_DTO, items: [two[1], two[0]] } as any,
        OPERATOR,
      );
      expect(res.id).toBe("ret-first");
    });

    it("a legacy row (captured before #2424, no fingerprint) still replays", async () => {
      prisma.return.findFirst.mockResolvedValueOnce(stored(null));
      const res: any = await service.capture(DIFFERENT as any, OPERATOR);
      expect(res.id).toBe("ret-first");
    });

    it("P2002 recovery with DIFFERENT items ⇒ 409 KEY_REUSED_WITH_DIFFERENT_ITEMS", async () => {
      prisma.tenantTransaction.mockImplementationOnce(async () => {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        err.meta = {
          driverAdapterError: { cause: { constraint: { index: "Return_tenantId_returnKey_key" } } },
        }; // the pg driver adapter's shape (B1186)
        throw err;
      });
      prisma.return.findFirst.mockResolvedValueOnce(null); // pre-tx: nothing yet
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items)); // the racer's row
      expect(await codeOf(service.capture(DIFFERENT as any, OPERATOR))).toBe(
        INLINE_RETURN_ERROR_CODES.RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
      );
    });

    it("in-lock re-check (captureInTx, the order create/edit path) with DIFFERENT items ⇒ 409, no create", async () => {
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items));
      expect(await codeOf(service.captureInTx(prisma, DIFFERENT as any, OPERATOR))).toBe(
        INLINE_RETURN_ERROR_CODES.RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("the order-path pre-read (preflightCapture) with DIFFERENT items ⇒ 409; SAME items ⇒ null (a replay)", async () => {
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items));
      await expect(
        service.preflightCapture(DIFFERENT as any, OPERATOR, { routeRunId: null }),
      ).rejects.toThrow(ConflictException);
      prisma.return.findFirst.mockResolvedValueOnce(stored(CAPTURE_DTO.items));
      await expect(
        service.preflightCapture(CAPTURE_DTO as any, OPERATOR, { routeRunId: null }),
      ).resolves.toBeNull();
    });
  });

  describe("#2695 (SA-557): a staff credit-price override on capture", () => {
    /** One matched chunk the engine lowered from $5.00 to $3.00 a piece (6 pieces). */
    function pricedOverride() {
      const base = priced(19.08, 18, 1.08, 0);
      return {
        ...base,
        chunks: [
          {
            ...base.chunks[0],
            priceSource: "MANUAL" as const,
            unitPrice: 3,
            originalPrice: 5,
            overrideReason: "damaged in transit",
            overriddenBy: "user-op-1",
          },
        ],
      };
    }
    const OVERRIDE_DTO = {
      ...CAPTURE_DTO,
      items: [
        { productId: "prod-1", qty: 6, creditUnitPrice: 3, overrideReason: "damaged in transit" },
      ],
    };

    it("persists the MANUAL line with the DEFAULT replaced, and writes ONE in-tx price_override audit row", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(pricedOverride());
      await service.capture(OVERRIDE_DTO as any, OPERATOR);

      const item = prisma.return.create.mock.calls[0][0].data.items.create[0];
      expect(item).toMatchObject({
        priceSource: "MANUAL",
        unitPrice: 3,
        originalPrice: 5,
        overrideReason: "damaged in transit",
        overriddenBy: "user-op-1",
      });
      const rows = prisma.auditLog.create.mock.calls.filter(
        ([a]: any[]) => a.data.action === "inline_return.price_override",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0][0].data).toEqual({
        userId: "user-op-1",
        action: "inline_return.price_override",
        entityType: "Return",
        entityId: "ret-1",
        meta: {
          orderId: "ord-carrying",
          customerId: "cust-1",
          items: [
            {
              productId: "prod-1",
              pieces: 6,
              defaultUnitPrice: 5,
              unitPrice: 3,
              reason: "damaged in transit",
            },
          ],
        },
      });
    });

    it("writes NO price_override row when nothing was overridden (a no-op for every existing client)", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(priced());
      await service.capture(CAPTURE_DTO as any, OPERATOR);
      expect(
        prisma.auditLog.create.mock.calls.filter(
          ([a]: any[]) => a.data.action === "inline_return.price_override",
        ),
      ).toHaveLength(0);
    });

    it("the audit row is written on the capture's OWN tx client, never the root prisma", async () => {
      const tx = createMockPrisma();
      tx.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 1000,
        status: "PENDING",
        routeRunId: "run-1",
      });
      tx.return.findFirst.mockResolvedValue(null);
      tx.return.findMany.mockResolvedValue([]);
      tx.return.create.mockImplementation(async ({ data }: any) => ({
        id: "ret-1",
        ...data,
        items: (data.items?.create ?? []).map((i: any, idx: number) => ({ id: `ri-${idx}`, ...i })),
      }));
      quoteService.priceInlineReturn.mockResolvedValue(pricedOverride());

      await service.captureInTx(tx, OVERRIDE_DTO as any, OPERATOR);

      const onTx = tx.auditLog.create.mock.calls.filter(
        ([a]: any[]) => a.data.action === "inline_return.price_override",
      );
      expect(onTx).toHaveLength(1);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("the same key with the same price but a DIFFERENT reason is a 409 too (the reason is fingerprinted)", async () => {
      prisma.return.findFirst.mockResolvedValueOnce({
        id: "ret-existing",
        returnNumber: "RET-2026-0009",
        returnKey: "nonce-1",
        kind: "INLINE",
        customerId: "cust-1",
        orderId: "ord-carrying",
        capturePayload: inlineReturnItemsFingerprint(OVERRIDE_DTO.items as any),
        items: [],
      });
      const reworded = {
        ...OVERRIDE_DTO,
        items: [{ ...OVERRIDE_DTO.items[0], overrideReason: "customer goodwill" }],
      };
      expect(await codeOf(service.capture(reworded as any, OPERATOR))).toBe(
        INLINE_RETURN_ERROR_CODES.RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("the #2424 fingerprint carries the override, so the same key with another price is a 409, not a replay", async () => {
      const stored = inlineReturnItemsFingerprint(OVERRIDE_DTO.items as any);
      expect(stored.items[0]).toMatchObject({
        creditUnitPrice: 3,
        overrideReason: "damaged in transit",
      });
      prisma.return.findFirst.mockResolvedValueOnce({
        id: "ret-existing",
        returnNumber: "RET-2026-0009",
        returnKey: "nonce-1",
        kind: "INLINE",
        customerId: "cust-1",
        orderId: "ord-carrying",
        capturePayload: stored,
        items: [],
      });
      const cheaper = {
        ...OVERRIDE_DTO,
        items: [{ ...OVERRIDE_DTO.items[0], creditUnitPrice: 2 }],
      };
      expect(await codeOf(service.capture(cheaper as any, OPERATOR))).toBe(
        INLINE_RETURN_ERROR_CODES.RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS,
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
    });
  });

  describe("MED-7: returnKey P2002 collision", () => {
    it("catches the conflict OUTSIDE the aborted transaction and replays when the raced row matches this (customerId, orderId)", async () => {
      prisma.tenantTransaction.mockImplementationOnce(async () => {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        err.meta = {
          driverAdapterError: { cause: { constraint: { index: "Return_tenantId_returnKey_key" } } },
        }; // the pg driver adapter's shape (B1186)
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
      // B735: same wrapping as the pre-tx replay branch — no longer referentially equal.
      expect(result).toEqual({ ...raced, parkedReversals: null });
    });

    it("throws a 409 Conflict (never a raw P2002) when the raced row belongs to someone else", async () => {
      prisma.tenantTransaction.mockImplementationOnce(async () => {
        const err: any = new Error("Unique constraint failed");
        err.code = "P2002";
        err.meta = {
          driverAdapterError: { cause: { constraint: { index: "Return_tenantId_returnKey_key" } } },
        }; // the pg driver adapter's shape (B1186)
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

      const p = service.capture(CAPTURE_DTO as any, OPERATOR);
      await expect(p).rejects.toThrow(ConflictException);
      expect(await codeOf(p)).toBe(INLINE_RETURN_ERROR_CODES.RETURN_KEY_CONFLICT);
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
      const p = service.capture(CAPTURE_DTO as any, OPERATOR);
      await expect(p).rejects.toThrow(BadRequestException);
      expect(await codeOf(p)).toBe(INLINE_RETURN_ERROR_CODES.ORDER_CANCELLED);
      expect(prisma.return.create).not.toHaveBeenCalled();
    });

    it("SA-204: a foreign-customer order and a missing order carry their own refusal codes", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-OTHER",
        total: 1000,
        status: "CONFIRMED",
        routeRunId: null,
      });
      expect(await codeOf(service.capture(CAPTURE_DTO as any, OPERATOR))).toBe(
        INLINE_RETURN_ERROR_CODES.ORDER_CUSTOMER_MISMATCH,
      );
      prisma.order.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.capture(CAPTURE_DTO as any, OPERATOR))).toBe(
        INLINE_RETURN_ERROR_CODES.ORDER_NOT_FOUND,
      );
    });
  });

  // ─── N-1: cancel racing between the re-read and the link ────────────────────

  it("N-1: a REPLAY re-issue (issueCredit) of a return that moved out of RECEIVED between its pre-read and its lock mints NOTHING (revert ⇒ orphaned CN)", async () => {
    // A fresh capture mints in its own transaction (row 347: nothing can move the return before it is visible), so the
    // cancel-vs-issue race lives on the replay path: a stuck RECEIVED return re-issued by a retry. The unlocked pre-read (m-2)
    // still sees RECEIVED, so issueCredit proceeds to open its tx.
    const stuck = {
      id: "ret-stuck",
      returnKey: "nonce-1",
      kind: "INLINE",
      status: "RECEIVED",
      creditNoteId: null,
      holdReason: null,
      customerId: "cust-1",
      orderId: "ord-carrying",
      creditSubtotal: 28,
      creditTax: 2,
      creditCategoryTax: 0,
      items: [],
    };
    prisma.return.findFirst
      .mockResolvedValueOnce(stuck) // capture()'s own pre-tx replay check: the stuck row
      .mockResolvedValueOnce(stuck) // issueCredit's own unlocked pre-read (m-2): still RECEIVED
      .mockResolvedValueOnce({ id: "ret-stuck", status: "CANCELLED", creditNoteId: null }); // its in-tx FOR-UPDATE re-read: cancel() won the race

    await service.capture(CAPTURE_DTO as any, OPERATOR);

    expect(prisma.return.create).not.toHaveBeenCalled();
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ creditNoteId: expect.anything() }),
      }),
    );
  });

  it("row 347 (1): a fresh STORE_CREDIT capture mints in the capture's OWN transaction: one transaction, no issueCredit re-read", async () => {
    const out = await service.capture(CAPTURE_DTO as any, OPERATOR);

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledTimes(1);
    // the intent keeps its full amount (the standalone path is not capped at the order's balance)
    expect(prisma.orderCreditNote.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 30 }) }),
    );
    expect(gateway.emitCreditNoteCreated).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ creditNoteId: "cn-1" });
  });

  describe("row 347 (1): the capture's one transaction has the order-create budget and its expiry / lock wait is a retryable 409", () => {
    it("opens it with a 15 s timeout (capture, restock, ledger, mint and settle in one transaction)", async () => {
      await service.capture(CAPTURE_DTO as any, OPERATOR);
      expect(prisma.tenantTransaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 15_000,
      });
    });

    const refuses = async (err: unknown) => {
      prisma.tenantTransaction.mockRejectedValueOnce(err);
      const e: any = await service.capture(CAPTURE_DTO as any, OPERATOR).then(
        () => null,
        (x) => x,
      );
      expect(e?.getStatus?.()).toBe(409);
      expect(e?.getResponse?.()).toMatchObject({ code: "CONCURRENT_UPDATE", retryable: true });
    };

    it("an expired transaction (Prisma P2028) is 409 CONCURRENT_UPDATE, never an uncoded 500", async () => {
      await refuses(Object.assign(new Error("Transaction API error"), { code: "P2028" }));
    });

    it("a lock wait that gave up (55P03) is the same retryable 409", async () => {
      await refuses(
        Object.assign(new Error("canceling statement due to lock timeout"), {
          meta: { code: "55P03" },
        }),
      );
    });

    it("any other failure still propagates as it was", async () => {
      prisma.tenantTransaction.mockRejectedValueOnce(new Error("boom"));
      await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toThrow("boom");
    });
  });

  it("row 347 (1): a source that went dead before the mint rolls the capture back (409 RETURN_CAPTURE_SOURCE_CLOSED, not the approve wording), no credit note and no event", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "invitem-1", invoiceId: "inv-dead" }]);
    prisma.invoice.findFirst.mockResolvedValue({ id: "inv-dead" });

    const err: any = await service.capture(CAPTURE_DTO as any, OPERATOR).then(
      () => null,
      (e) => e,
    );

    expect(err.getStatus()).toBe(409);
    expect(err.getResponse().code).toBe("RETURN_CAPTURE_SOURCE_CLOSED");
    // nothing exists to cancel or reject: the capture rolled back, and the words say so
    expect(err.getResponse().message).toMatch(/Nothing was recorded/);
    expect(err.getResponse().message).not.toMatch(/cancel|reject/i);
    // the source line itself gone: the same capture refusal and words
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    const gone: any = await service.capture(CAPTURE_DTO as any, OPERATOR).then(
      () => null,
      (e) => e,
    );
    expect(gone.getResponse().code).toBe("RETURN_CAPTURE_SOURCE_CLOSED");
    expect(gone.getResponse().message).not.toMatch(/cancel|reject/i);
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "invitem-1", invoiceId: "inv-dead" }]);
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    expect(gateway.emitCreditNoteCreated).not.toHaveBeenCalled();
    // the whole refusal is inside the one transaction (two captures were driven above: the dead invoice and the lost line)
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
  });

  // ─── the N-1 guarded link's exact refusal literal — pinned cross-boundary (SA-091b) ──
  //
  // The mobile client (apps/mobile/lib/inline-return-submit-key.ts's
  // isDefiniteInlineReturnRefusal) parses THIS EXACT MESSAGE to decide the return-key is still
  // safe to retry (this is a 409 the server DID answer, but whether the mint that already ran
  // in this same transaction committed is what the ROLLBACK undoes — the caller must retry with
  // the SAME returnKey, never mint a fresh one). No structured error code exists yet
  // (RETURN_STATE_RACE_RETRY is a proposed follow-up); until then this string is the only
  // contract between the two sides, so a reword here without a matching mobile update would
  // silently break that retry classification. If this test ever needs to change, update
  // RETURN_STATE_RACE_RETRY_MESSAGE in apps/mobile/lib/inline-return-submit-key.ts too.
  it('issueCreditInTx\'s N-1 guarded-link miss throws EXACTLY "Return changed state during credit issue — retry" — pinned for the mobile retry-classification contract', async () => {
    prisma.return.findFirst
      .mockResolvedValueOnce(null) // capture()'s own pre-tx replay check
      .mockResolvedValueOnce(null) // capture()'s in-tx replay check — none found, proceeds to create
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
      }) // issueCredit's own unlocked pre-read (m-2)
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
      }); // issueCredit's in-tx FOR-UPDATE re-read: still RECEIVED, proceeds to mint
    // A racer's own issueCredit already linked this return's credit note between this call's
    // FOR-UPDATE re-read and its own updateMany — the guarded link matches 0 rows.
    prisma.return.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.capture(CAPTURE_DTO as any, OPERATOR)).rejects.toThrow(
      "Return changed state during credit issue — retry",
    );
    expect(creditNotes.mintStandaloneInTx).toHaveBeenCalled();
  });

  // ─── approve / reject (N-5, Q-C, HIGH-2, HIGH-4) ─────────────────────────────

  // ─── B961 / SA-071c: a chunk of goods the customer ALREADY returned or was credited for ──────────

  describe("B961: an 'already returned or credited' chunk is staff-with-a-reason only; a driver capture is held", () => {
    const alreadyReturnedQuote = () => {
      const q = priced(30, 28, 2, 0);
      q.chunks[0] = {
        ...q.chunks[0],
        sourceInvoiceItemId: null,
        sourceOrderId: null,
        sourceOrderItemId: null,
        priceSource: "BASE" as const,
        alreadyReturned: true,
      } as any;
      return q;
    };
    const withReason = (reason?: string) => ({
      ...CAPTURE_DTO,
      returnKey: "nonce-ar",
      items: [
        {
          productId: "prod-1",
          qty: 6,
          ...(reason !== undefined ? { alreadyReturnedReason: reason } : {}),
        },
      ],
    });

    it("STAFF without a reason is a 400 INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED (readable) and NOTHING is written", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(alreadyReturnedQuote());
      const err: any = await service.capture(withReason() as any, OPERATOR).catch((e) => e);
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({
        code: "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
      });
      expect(String(err.getResponse().message)).toMatch(/already returned or credited/i);
      expect(prisma.return.create).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("a blank / whitespace reason is the same refusal", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(alreadyReturnedQuote());
      expect(await codeOf(service.capture(withReason("   ") as any, OPERATOR))).toBe(
        "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
      );
    });

    it("STAFF with a reason is credited, and an audit row records the ACTOR and the REASON", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(alreadyReturnedQuote());
      await service.capture(withReason("  customer kept the first credit slip  ") as any, OPERATOR);
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "inline_return.already_returned_credit",
            userId: OPERATOR.sub,
            meta: expect.objectContaining({
              items: [
                expect.objectContaining({
                  productId: "prod-1",
                  reason: "customer kept the first credit slip",
                }),
              ],
            }),
          }),
        }),
      );
    });

    it("a DRIVER capture is HELD for the office: no restock, no ledger reversal, no credit note; audited; the response says why", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(alreadyReturnedQuote());
      const result: any = await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);
      expect(prisma.return.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ holdReason: "ALREADY_RETURNED", heldAmount: 30 }),
        }),
      );
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "inline_return.already_returned_hold",
            entityId: "ret-1",
          }),
        }),
      );
      expect(result.alreadyReturnedHold).toBe(true);
      expect(String(result.holdMessage)).toMatch(/already returned or credited/i);
    });

    it("when BOTH the driver cap and the flag apply, ALREADY_RETURNED wins (it needs a reason)", async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 5, // tiny gross: the $30 return is also over the driver cap
        status: "PENDING",
        routeRunId: "run-1",
      });
      quoteService.priceInlineReturn.mockResolvedValue(alreadyReturnedQuote());
      await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);
      expect(prisma.return.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ holdReason: "ALREADY_RETURNED" }),
        }),
      );
    });

    it("a chunk that is NOT flagged is untouched: a staff capture needs no reason, a driver capture is not held", async () => {
      await service.capture({ ...CAPTURE_DTO, returnKey: "nonce-plain" } as any, OPERATOR);
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalled();
      prisma.return.create.mockClear();
      await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);
      expect(prisma.return.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ holdReason: "DRIVER_CAP" }),
        }),
      );
    });

    it("the edit-path PREFLIGHT refuses a staff return without the reason BEFORE anything commits outside the tx", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(alreadyReturnedQuote());
      const code = await codeOf(
        service.preflightCapture(
          { ...withReason(), customerId: "cust-1", orderId: "ord-carrying" } as any,
          OPERATOR,
          { routeRunId: null },
        ),
      );
      expect(code).toBe("INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED");
    });

    it("the NEW-order preflight refuses a staff return without the reason BEFORE a credit-note number is reserved", async () => {
      quoteService.priceInlineReturn.mockResolvedValue(alreadyReturnedQuote());
      const code = await codeOf(
        service.preflightNewOrderReturn(
          { items: [{ productId: "prod-1", qty: 6 }], returnKey: "k-new" } as any,
          "cust-1",
          OPERATOR,
        ),
      );
      expect(code).toBe("INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED");
    });

    it("N4: a REPLAY of the held capture keeps the readable holdMessage", async () => {
      const heldRow = {
        id: "ret-held-replay",
        kind: "INLINE",
        status: "RECEIVED",
        holdReason: "ALREADY_RETURNED",
        heldAmount: 30,
        creditNoteId: null,
        customerId: "cust-1",
        orderId: "ord-carrying",
        returnKey: "nonce-driver",
        capturePayload: null,
        items: [{ productId: "prod-1", qty: 6 }],
      };
      prisma.return.findFirst.mockResolvedValue(heldRow); // no audit rows are read: the COLUMN carries the hold
      const result: any = await service.capture(DRIVER_CAPTURE_DTO as any, DRIVER);
      expect(result.alreadyReturnedHold).toBe(true);
      expect(String(result.holdMessage)).toMatch(/already returned or credited/i);
    });

    describe("approving an already-returned hold", () => {
      const HELD_AR: any = {
        id: "ret-held",
        kind: "INLINE",
        status: "RECEIVED",
        holdReason: "ALREADY_RETURNED",
        heldAmount: 30,
        creditNoteId: null,
        customerId: "cust-1",
        orderId: "ord-carrying",
        creditSubtotal: 28,
        creditTax: 2,
        creditCategoryTax: 0,
        returnNumber: "RET-1",
        items: [{ productId: "prod-1", qty: 6, restock: true, sourceOrderId: null }],
      };
      beforeEach(() => {
        prisma.return.findFirst.mockResolvedValue(HELD_AR);
        prisma.return.updateMany.mockResolvedValue({ count: 1 });
        // SA-071f N3: approve() reads the holdReason COLUMN; the audit rows are evidence only. None exist here (as if pruned).
        prisma.auditLog.findFirst.mockResolvedValue(null);
      });

      it("without a reason is the same coded 400 and nothing is minted", async () => {
        expect(await codeOf(service.approve("ret-held", OPERATOR))).toBe(
          "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
        );
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      });

      it("with a reason it mints and audits the actor + reason", async () => {
        await service.approve("ret-held", OPERATOR, {
          reason: " verified with the office ",
        } as any);
        expect(creditNotes.mintStandaloneInTx).toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: "inline_return.already_returned_credit",
              userId: OPERATOR.sub,
              meta: expect.objectContaining({ reason: "verified with the office" }),
            }),
          }),
        );
      });

      it("a DRIVER_CAP-only hold approves exactly as before (no reason needed)", async () => {
        prisma.return.findFirst.mockResolvedValue({ ...HELD_AR, holdReason: "DRIVER_CAP" });
        await service.approve("ret-held", OPERATOR);
        expect(creditNotes.mintStandaloneInTx).toHaveBeenCalled();
      });
    });
  });

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

    it("SA-773 N4: a source invoice voided or written off since the capture is refused 409 RETURN_NOTHING_BILLED before any restock, reversal or mint", async () => {
      prisma.return.findFirst.mockResolvedValue({
        ...HELD,
        items: [{ ...HELD.items[0], sourceInvoiceItemId: "line-1" }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoiceItem.findMany.mockResolvedValue([{ id: "line-1", invoiceId: "inv-dead" }]);
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-dead" });

      const err: any = await service.approve("ret-held", OPERATOR).catch((e: any) => e);

      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "RETURN_NOTHING_BILLED",
        invoiceId: "inv-dead",
      });
      // the dead statuses are asked for by the shared set (VOID, WRITTEN_OFF), not by a literal in the guard
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ["inv-dead"] }, status: { in: ["VOID", "WRITTEN_OFF"] } },
        }),
      );
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("SA-773 N4: a source line that no longer exists fails closed the same way (no pool, so it would be minted unchecked)", async () => {
      prisma.return.findFirst.mockResolvedValue({
        ...HELD,
        items: [{ ...HELD.items[0], sourceInvoiceItemId: "line-gone" }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoiceItem.findMany.mockResolvedValue([]);

      const err: any = await service.approve("ret-held", OPERATOR).catch((e: any) => e);

      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "RETURN_NOTHING_BILLED" });
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("SA-773 N4: a rebuilt invoice (the stored line id is gone, the same order line lives on a new line) is re-resolved and approved; the re-resolved invoice is the one checked", async () => {
      prisma.return.findFirst.mockResolvedValue({
        ...HELD,
        items: [{ ...HELD.items[0], sourceInvoiceItemId: "line-old", sourceOrderItemId: "oi-1" }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
        where?.orderItemId
          ? [
              {
                id: "line-new",
                invoiceId: "inv-live",
                orderItemId: "oi-1",
                invoice: { orderId: "src-order-1", status: "PAID" },
              },
            ]
          : [],
      );
      prisma.invoice.findFirst.mockResolvedValue(null);

      await service.approve("ret-held", OPERATOR);

      expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ["inv-live"] }, status: { in: ["VOID", "WRITTEN_OFF"] } },
        }),
      );
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledTimes(1);
    });

    it("SA-773 N4: a rebuilt line on a dead invoice is still dead (it is the re-resolved invoice that is refused)", async () => {
      prisma.return.findFirst.mockResolvedValue({
        ...HELD,
        items: [{ ...HELD.items[0], sourceInvoiceItemId: "line-old", sourceOrderItemId: "oi-1" }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
        where?.orderItemId
          ? [
              {
                id: "line-new",
                invoiceId: "inv-dead",
                orderItemId: "oi-1",
                invoice: { orderId: "src-order-1", status: "VOID" },
              },
            ]
          : [],
      );
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-dead" });

      const err: any = await service.approve("ret-held", OPERATOR).catch((e: any) => e);

      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "RETURN_NOTHING_BILLED",
        invoiceId: "inv-dead",
      });
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("SA-773 N4: a live source invoice (no dead one found) is approved as before", async () => {
      prisma.return.findFirst.mockResolvedValue({
        ...HELD,
        items: [{ ...HELD.items[0], sourceInvoiceItemId: "line-1" }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.invoiceItem.findMany.mockResolvedValue([{ id: "line-1", invoiceId: "inv-live" }]);
      prisma.invoice.findFirst.mockResolvedValue(null);

      await service.approve("ret-held", OPERATOR);

      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledTimes(1);
    });

    it("REG-B735-api-approve-parked: approve() reverses the ledger it deferred from capture, and its own response carries any resulting park", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([{ returnedPieces: 6 }]);

      const result = await service.approve("ret-held", OPERATOR);

      expect(ledger.reverseReturnEntries).toHaveBeenCalled();
      expect(prisma.regulatedLedgerParkedReversal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            returnId: "ret-held",
            tenantId: "test-tenant",
            resolvedAt: null,
          }),
        }),
      );
      expect((result as any).parkedReversals).toEqual({ count: 1, pieces: 6 });
    });

    // #2143: approve() commits, then the post-commit read-back fails. The operator retries the
    // SAME approval: the unlocked pre-check used to see creditNoteId set and 400. An
    // already-APPROVED hold must return its current state, idempotently, with no money write.
    const APPROVED: any = {
      ...HELD,
      status: "REFUNDED",
      holdReason: null,
      creditNoteId: "cn-approved",
      approvedById: "user-op",
      approvedAt: new Date("2026-09-27T06:00:00Z"),
    };

    it("#2143: a retry of an already-approved return gets its current state, no second write", async () => {
      prisma.return.findFirst.mockResolvedValue(APPROVED);
      prisma.return.findUnique.mockResolvedValue(APPROVED);
      prisma.regulatedLedgerParkedReversal.findMany.mockResolvedValue([]);
      prisma.tenantTransaction.mockClear();

      const result = await service.approve("ret-held", OPERATOR);

      expect(result).toMatchObject({
        id: "ret-held",
        status: "REFUNDED",
        creditNoteId: "cn-approved",
      });
      expect((result as any).parkedReversals).toBeNull();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("#2143: the retry's amount does not matter — the first approval stands, nothing is written", async () => {
      prisma.return.findFirst.mockResolvedValue(APPROVED);
      prisma.return.findUnique.mockResolvedValue(APPROVED);
      await expect(service.approve("ret-held", OPERATOR, { amount: 5 })).resolves.toMatchObject({
        creditNoteId: "cn-approved",
      });
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("#2143: an already-approved retry whose re-read comes back empty is a 404, no write", async () => {
      prisma.return.findFirst.mockResolvedValue(APPROVED);
      prisma.return.findUnique.mockResolvedValue(null);
      prisma.tenantTransaction.mockClear();
      await expect(service.approve("ret-held", OPERATOR)).rejects.toThrow(NotFoundException);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("#2143: a return issued WITHOUT a hold (never approved) still refuses approve()", async () => {
      prisma.return.findFirst.mockResolvedValue({
        ...APPROVED,
        approvedById: null,
        approvedAt: null,
      });
      await expect(service.approve("ret-held", OPERATOR)).rejects.toThrow(BadRequestException);
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

    it("REG-B735-api-approve-read-fails: a failed parked-reversal read does not 500 committed approve work; the field is ABSENT", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.regulatedLedgerParkedReversal.findMany.mockRejectedValue(new Error("db down"));

      const result = await service.approve("ret-held", OPERATOR);

      expect(result).toBeDefined();
      expect(result).not.toHaveProperty("parkedReversals");
    });

    it("B735: 404s when the post-approve read comes back null, never returns a fake record", async () => {
      prisma.return.findFirst.mockResolvedValue(HELD);
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      prisma.return.findUnique.mockResolvedValue(null);

      await expect(service.approve("ret-held", OPERATOR)).rejects.toThrow(NotFoundException);
      expect(prisma.regulatedLedgerParkedReversal.findMany).not.toHaveBeenCalled();
    });
  });

  describe("reject", () => {
    it("declines a driver-cap hold — REJECTED, holdReason left AS-IS, no credit note ever minted, nothing restocked", async () => {
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.reject("ret-held", OPERATOR);
      expect(prisma.return.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // B961: an ALREADY_RETURNED hold is rejectable too (the same hold family)
          where: expect.objectContaining({
            holdReason: { in: ["DRIVER_CAP", "ALREADY_RETURNED"] },
          }),
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

      expect(creditNotes.cancelStandaloneInTx).toHaveBeenCalledWith(expect.anything(), "cn-1", {
        orderIds: ["ord-carrying"],
        invoiceIds: [],
      });
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderId: "ord-carrying", creditNoteId: "cn-1" } }),
      );
    });

    it("SA-773 follow-up (A): locks the carrying Order and every order the note was applied to in ONE id-sorted statement, then those invoices, before the pull-back writes", async () => {
      const events: string[] = [];
      const text = (strings: TemplateStringsArray, values: any[]) =>
        strings.reduce((acc, str, i) => acc + str + (i < values.length ? "?" : ""), "");
      const ids = (values: any[]) =>
        values.flatMap((v) => (v && Array.isArray(v.values) ? v.values : [v])).join(",");
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn({
          ...prisma,
          $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: any[]) => {
            const t = text(strings, values);
            if (/FROM "Order"/.test(t)) events.push(`orders:${ids(values.slice(0, 1))}`);
            else if (/FROM "Invoice"/.test(t)) events.push(`invoices:${ids(values.slice(0, 1))}`);
            else if (/FROM "Return"/.test(t)) events.push("return");
            return Promise.resolve(0);
          }),
        }),
      );
      creditNotes.cancelLockSet.mockResolvedValue({
        orderIds: ["ord-other-a", "ord-other-b"],
        invoiceIds: ["inv-other-a", "inv-other-b"],
      });
      creditNotes.cancelStandaloneInTx.mockImplementation(async () => {
        events.push("restore");
        return { restored: 30 };
      });
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-refunded",
        status: "REFUNDED",
        holdReason: null,
        items: [],
        orderId: "ord-carrying",
        creditNoteId: "cn-1",
      });

      await service.cancel("ret-refunded", OPERATOR);

      // ONE Order statement (the carrying order sorted among the others by the lock helper), the invoices after it,
      // and the restore only after both: nothing of another order's invoice is written before its Order is held
      expect(events).toEqual([
        "return",
        "orders:ord-carrying,ord-other-a,ord-other-b",
        "invoices:inv-other-a,inv-other-b",
        "restore",
      ]);
      expect(creditNotes.cancelStandaloneInTx).toHaveBeenCalledWith(expect.anything(), "cn-1", {
        orderIds: ["ord-carrying", "ord-other-a", "ord-other-b"],
        invoiceIds: ["inv-other-a", "inv-other-b"],
      });
    });

    it("a return that is not REFUNDED never reads a note's lock set", async () => {
      prisma.return.findFirst.mockResolvedValue({
        id: "ret-received",
        status: "RECEIVED",
        holdReason: null,
        items: [],
        orderId: "ord-carrying",
        creditNoteId: null,
      });
      await service.cancel("ret-received", OPERATOR);
      expect(creditNotes.cancelLockSet).not.toHaveBeenCalled();
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

// SA-204: the mobile capture classifier settles a 4xx ONLY when the body carries one of the
// capture service's own error codes (a post-lookup business refusal); everything else keeps the
// nonce. These pin the codes the server puts on each such refusal, and that the mobile client's
// set is exactly this set (read from the mobile source, the enum-parity precedent).
describe("InlineReturnsService — refusal codes (SA-204)", () => {
  it("exports the six capture refusal codes", () => {
    expect(INLINE_RETURN_ERROR_CODES).toEqual({
      ORDER_NOT_FOUND: "INLINE_RETURN_ORDER_NOT_FOUND",
      ORDER_CUSTOMER_MISMATCH: "INLINE_RETURN_ORDER_CUSTOMER_MISMATCH",
      ORDER_CANCELLED: "INLINE_RETURN_ORDER_CANCELLED",
      ALREADY_RETURNED_REASON_REQUIRED: "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
      RETURN_KEY_CONFLICT: "INLINE_RETURN_KEY_CONFLICT",
      RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS: "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS", // #2424
    });
  });

  it("the mobile client's refusal-code set is exactly the server's (compared as SETS, both ways)", () => {
    const mobile = readFileSync(
      join(__dirname, "..", "..", "..", "mobile", "lib", "inline-return-submit-key.ts"),
      "utf8",
    );
    const decl = /INLINE_RETURN_REFUSAL_CODES[^=]*=\s*\[([\s\S]*?)\]/.exec(mobile);
    expect(decl).not.toBeNull();
    const mobileSet = new Set([...decl![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
    const serverSet = new Set<string>(Object.values(INLINE_RETURN_ERROR_CODES));
    expect(mobileSet.size).toBeGreaterThan(0);
    for (const c of serverSet) expect(mobileSet).toContain(c); // nothing the server sends is missing on the client
    for (const c of mobileSet) expect(serverSet).toContain(c); // nothing the client trusts is unknown to the server
  });
});
