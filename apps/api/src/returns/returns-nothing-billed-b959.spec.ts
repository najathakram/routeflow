import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * B959 (LOW money): a return of a product with NO billed invoice line used to price $0, claim REFUNDED and mint no credit note
 * (a silent $0 under-credit). Now: when NOTHING the customer returned was billed on the order's creditable invoices, processRefund
 * refuses 400 RETURN_NOTHING_BILLED BEFORE the claim; in a MIXED return the billed part is refunded and the unbilled item is
 * reported as a readable "not billed, no refund" line (never a silent $0). A billed $0 (free) line is billed. EXTERNAL_REFUND
 * mints nothing by design and is untouched; an order with no invoice at all keeps the legacy order-line basis.
 */
const LINE_A = { id: "line-a", productId: "pa", qty: 1, subtotal: 100 };
const order = (invoices: any[]) => ({ id: "ord-1", orderNumber: "ORD-1", invoices, lineItems: [] });
const invoice = (id: string, items: any[]) => ({
  id,
  invoiceNumber: id.toUpperCase(),
  status: "SENT",
  total: 100,
  createdAt: new Date("2026-01-01"),
  items,
});

describe("ReturnsService.processRefund: B959 nothing billed", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let create: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    create = jest.fn().mockResolvedValue({ id: "cn-1" });
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: { create } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({});
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    prisma.creditNoteItem.findMany.mockResolvedValue([]);
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.return.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([
      { id: "pz", name: "Stray Item" },
      { id: "pa", name: "Item A" },
    ]);
  });

  const withReturn = (ord: any, items: Array<{ productId: string; qty: number }>) =>
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      returnNumber: "RET-1",
      status: "RECEIVED",
      customerId: "cust-1",
      items,
      order: ord,
    });

  it("1. a return of a product with NO billed line is REFUSED 400 RETURN_NOTHING_BILLED before the claim; nothing is minted", async () => {
    withReturn(order([invoice("inv-1", [LINE_A])]), [{ productId: "pz", qty: 1 }]);
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "RETURN_NOTHING_BILLED" });
    expect(String(err.getResponse().message)).toMatch(/nothing to refund|not billed/i);
    expect(prisma.return.updateMany).not.toHaveBeenCalled(); // before the RECEIVED->REFUNDED claim
    expect(create).not.toHaveBeenCalled();
  });

  it("2. a BILLED $0 (free) line returned is billed: not refused, resolves as today", async () => {
    const free = { id: "line-free", productId: "pf", qty: 1, subtotal: 0 };
    withReturn(order([invoice("inv-1", [free, LINE_A])]), [{ productId: "pf", qty: 1 }]);
    const res: any = await service.processRefund("ret-1");
    expect(prisma.return.updateMany).toHaveBeenCalled();
    expect(res.unbilledItems ?? []).toEqual([]);
  });

  it("3. a MIXED return refunds the billed part and reports the unbilled item as a readable line (never a silent $0)", async () => {
    withReturn(order([invoice("inv-1", [LINE_A])]), [
      { productId: "pa", qty: 1 },
      { productId: "pz", qty: 2 },
    ]);
    const res: any = await service.processRefund("ret-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].amount).toBe(100); // only the billed part
    expect(res.unbilledItems).toEqual([
      {
        productId: "pz",
        name: "Stray Item",
        qty: 2,
        message: "Stray Item was not billed on this order, so no refund was given for it.",
      },
    ]);
  });

  it("4. EXTERNAL_REFUND is untouched: it mints nothing by design and still resolves an unbilled-only return", async () => {
    withReturn(order([invoice("inv-1", [LINE_A])]), [{ productId: "pz", qty: 1 }]);
    const res: any = await service.processRefund("ret-1", { method: "EXTERNAL_REFUND" } as any);
    expect(res.status ?? "REFUNDED").toBeDefined();
    expect(prisma.return.updateMany).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("5. an order with NO invoice rows keeps the legacy order-line basis (no refusal); a VOID-only order keeps its own refusal", async () => {
    withReturn(
      {
        ...order([]),
        lineItems: [
          { productId: "pa", qty: 1, unitPrice: 100, subtotal: 100, status: "DELIVERED" },
        ],
      },
      [{ productId: "pa", qty: 1 }],
    );
    await service.processRefund("ret-1");
    expect(create).toHaveBeenCalledTimes(1);
    create.mockClear();
    prisma.return.updateMany.mockClear();
    withReturn(order([{ ...invoice("inv-1", [LINE_A]), status: "VOID" }]), [
      { productId: "pa", qty: 1 },
    ]);
    const err = await service.processRefund("ret-1").catch((e) => e);
    expect(err.message).toMatch(/Nothing billed on this order can be refunded/);
    expect(create).not.toHaveBeenCalled();
  });
});
