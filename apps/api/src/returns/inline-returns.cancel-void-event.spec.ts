/**
 * B548: cancelling a REFUNDED inline return voids the return's credit note (`cancelStandaloneInTx`), but unlike the
 * other void paths (`voidWithReversal`, reissue) it emitted no `creditNote.voided` event, so an open credit-notes list
 * or customer statement showed the dead note as live until a reload.
 *
 * `cancelStandaloneInTx` now reports the note it flipped; `InlineReturnsService.cancel` emits AFTER the transaction
 * resolves, never inside it, and never when the transaction throws.
 *
 * Bootstrap and the REFUNDED-cancel mocks follow inline-returns.service.spec.ts ("cancel").
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
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
import { wireStockHelper } from "../inventory/testing/stock-helper-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const OPERATOR = {
  sub: "user-op-1",
  role: "OPERATOR",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

const VOIDED = {
  creditNoteId: "cn-1",
  creditNoteNumber: "CN-0001",
  customerId: "cust-1",
  amount: 30,
};

describe("B548: cancelling an inline return emits creditNote.voided after commit", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotes: { cancelStandaloneInTx: jest.Mock };
  let gateway: { emitCreditNoteVoided: jest.Mock; emitCreditNoteCreated: jest.Mock };
  let events: string[];

  const returnRow = (status: string, creditNoteId: string | null) => ({
    id: "ret-1",
    status,
    holdReason: null,
    items: [{ productId: "prod-1", qty: 6, restock: true }],
    orderId: "ord-carrying",
    creditNoteId,
  });

  beforeEach(async () => {
    events = [];
    prisma = createMockPrisma();
    wireStockHelper(prisma, { ample: true });
    creditNotes = {
      cancelStandaloneInTx: jest.fn(async () => {
        events.push("cancelStandaloneInTx");
        return { restored: 30, voided: VOIDED };
      }),
    };
    gateway = {
      emitCreditNoteVoided: jest.fn(() => {
        events.push("emit");
      }),
      emitCreditNoteCreated: jest.fn(),
    };
    const realTx = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation(async (...args: any[]) => {
      const out = await (realTx as any)(...args);
      events.push("tx-resolved");
      return out;
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.findUnique.mockResolvedValue({ id: "ret-1", status: "CANCELLED" });
    prisma.product.findFirst.mockResolvedValue({ currentStock: 20, averageCost: 5 });

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        {
          provide: RegulatedLedgerService,
          useValue: {
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        { provide: CreditNotesService, useValue: creditNotes },
        { provide: NumberingService, useValue: {} },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
        { provide: InlineReturnsQuoteService, useValue: {} },
        { provide: IdempotencyService, useValue: {} },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  it("a REFUNDED return with a credit note: emitCreditNoteVoided once, with the note's id, number, customer and amount, after the transaction resolved", async () => {
    prisma.return.findFirst.mockResolvedValue(returnRow("REFUNDED", "cn-1"));

    await service.cancel("ret-1", OPERATOR);

    expect(gateway.emitCreditNoteVoided).toHaveBeenCalledTimes(1);
    expect(gateway.emitCreditNoteVoided).toHaveBeenCalledWith("test-tenant", VOIDED);
    expect(events).toEqual(["cancelStandaloneInTx", "tx-resolved", "emit"]);
  });

  it("the method's return value is unchanged: the cancelled row plus amendedPeriod, no internal field", async () => {
    prisma.return.findFirst.mockResolvedValue(returnRow("REFUNDED", "cn-1"));

    const result = await service.cancel("ret-1", OPERATOR);

    expect(result).toEqual({ id: "ret-1", status: "CANCELLED", amendedPeriod: null });
  });

  it("a RECEIVED return (no credit note yet) emits nothing", async () => {
    prisma.return.findFirst.mockResolvedValue(returnRow("RECEIVED", null));

    await service.cancel("ret-1", OPERATOR);

    expect(creditNotes.cancelStandaloneInTx).not.toHaveBeenCalled();
    expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
  });

  it("a credit note that was already VOID (cancelStandaloneInTx flipped nothing) emits nothing", async () => {
    prisma.return.findFirst.mockResolvedValue(returnRow("REFUNDED", "cn-1"));
    creditNotes.cancelStandaloneInTx.mockResolvedValue({ restored: 0 });

    await service.cancel("ret-1", OPERATOR);

    expect(creditNotes.cancelStandaloneInTx).toHaveBeenCalledTimes(1);
    expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
  });

  it("a throw inside the transaction after the note was voided emits nothing (rolled back)", async () => {
    prisma.return.findFirst.mockResolvedValue(returnRow("REFUNDED", "cn-1"));
    // cancelStandaloneInTx reported the void, then the cancel fails further down the transaction.
    prisma.orderCreditNote.deleteMany.mockRejectedValue(new BadRequestException("boom"));

    await expect(service.cancel("ret-1", OPERATOR)).rejects.toThrow("boom");

    expect(creditNotes.cancelStandaloneInTx).toHaveBeenCalledTimes(1);
    expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
  });

  it("a refusal from cancelStandaloneInTx itself (credit consumed) emits nothing", async () => {
    prisma.return.findFirst.mockResolvedValue(returnRow("REFUNDED", "cn-1"));
    creditNotes.cancelStandaloneInTx.mockRejectedValue(
      new BadRequestException("RETURN_CREDIT_CONSUMED"),
    );

    await expect(service.cancel("ret-1", OPERATOR)).rejects.toThrow("RETURN_CREDIT_CONSUMED");

    expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
  });
});
