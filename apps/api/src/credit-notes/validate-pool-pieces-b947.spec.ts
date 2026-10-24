import { Test } from "@nestjs/testing";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B947 r4 N1: the create() call site of the ORDER POOL passes the credit note's qty in PIECES (its line's own qty axis times that
 * line's pieces-per-qty). The fixtures use a 2-BOX x12 line so removing the conversion (credit-notes.service.ts) turns this red.
 */
describe("CreditNotesService.validateAndBuildCnItems: B947 the pooled take is in PIECES", () => {
  let service: CreditNotesService;

  beforeEach(async () => {
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: createMockPrisma() },
        { provide: RouteFlowGateway, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CommissionEngineService, useValue: {} },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  const row = (
    id: string,
    productId: string,
    subtotal: number,
    qty: number,
    upb: number | null,
  ) => ({
    id,
    productId,
    subtotal,
    qty,
    boxes: null,
    unitsPerBox: upb,
    pieces: null,
    product: { unitsPerBox: null },
    trackedCategoryId: null,
    categoryTaxAmount: 0,
  });
  const mBox = row("m-box", "pm", 240, 2, 12); // 2 BOXES x12 = 24 pieces, on X
  const mPcs = row("m-pcs", "pm", 60, 12, null); // 12 PIECES, on Y

  /** X holds the box line; Y the pieces line; an itemless refund lump of pm sits on Y (invisible to X's own per-line check). */
  const fakeDb = () => {
    const invoices = [
      { id: "inv-mx", items: [mBox] },
      { id: "inv-my", items: [mPcs] },
    ];
    return {
      invoice: {
        findFirst: jest.fn().mockResolvedValue({
          total: 300,
          customerId: "cust-1",
          status: "SENT",
          orderId: "ord-1",
          items: [mBox],
        }),
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue(invoices),
      },
      creditNote: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        // per-invoice legacy term (by invoiceId): nothing on X; the POOL read (by OR) finds the lump
        findMany: jest.fn(async (args: any) =>
          args.where.invoiceId !== undefined ? [] : [{ id: "cn-lump" }],
        ),
      },
      creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
      returnItem: { findMany: jest.fn().mockResolvedValue([]) },
      return: {
        findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "pm", qty: 12 }] }]),
      },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
  };
  const dto = (qty: number, amount = 40) => ({
    customerId: "cust-1",
    invoiceId: "inv-mx",
    amount,
    items: [{ invoiceItemId: "m-box", amount, qty }],
  });

  it("a credit note item of ONE BOX (12 pieces) on X's box line is REFUSED by the pool: the lump on Y leaves only 2 pieces (raw qty 1 would pass)", async () => {
    await expect(service.validateAndBuildCnItems(fakeDb(), dto(1), {})).rejects.toMatchObject({
      response: { code: "CREDIT_NOTE_OVER_HEADROOM" },
    });
  });

  it("the same take with no lump in the pool passes (the refusal is the pool's, not the line's own)", async () => {
    const db = fakeDb();
    db.creditNote.findMany.mockResolvedValue([]);
    await expect(service.validateAndBuildCnItems(db, dto(1), {})).resolves.toHaveLength(1);
  });
});
