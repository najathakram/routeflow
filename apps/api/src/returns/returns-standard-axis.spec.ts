/**
 * B650 / B754 / B671 (SA-158): a STANDARD return's typed qty is in the order line's OWN unit
 * (unchanged on disk, money unchanged); the over-return CAP and the prior-returned sum are
 * computed in PIECES through the same `resolvePackFactors` the restock resolver uses. An
 * unknown pack, or a product on lines with different factors, is REFUSED (409) — never booked
 * as factor 1.
 */
import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { returnedPiecesByProduct } from "./returns-pieces.util";

const line = (over: Record<string, unknown>) => ({
  id: "l1",
  productId: "p1",
  qty: 2,
  unitPrice: 60,
  subtotal: 120,
  status: "CONFIRMED",
  position: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  product: { unitsPerBox: 12 },
  ...over,
});

async function harness(opts: {
  lineItems: any[];
  invoiceItems?: any[];
  priorStandard?: any[];
  priorInline?: any[];
}) {
  const prisma = createMockPrisma();
  prisma.order.findUnique.mockResolvedValue({
    id: "ord-1",
    status: "DELIVERED",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Co" },
    lineItems: opts.lineItems,
    invoices: [{ id: "inv-1" }],
  } as any);
  const txReturn = {
    findMany: jest.fn().mockResolvedValue(opts.priorStandard ?? []),
    create: jest.fn().mockResolvedValue({ id: "ret-1", items: [] }),
  };
  prisma.tenantTransaction.mockImplementation((fn: any) =>
    fn({
      return: txReturn,
      returnItem: { findMany: jest.fn().mockResolvedValue(opts.priorInline ?? []) },
      orderItem: { findMany: jest.fn().mockResolvedValue(opts.lineItems) },
      invoiceItem: { findMany: jest.fn().mockResolvedValue(opts.invoiceItems ?? []) },
      order: prisma.order,
      customer: prisma.customer,
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn(),
    }),
  );
  const mod = await Test.createTestingModule({
    providers: [
      ReturnsService,
      { provide: PrismaService, useValue: prisma },
      { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
      { provide: RegulatedLedgerService, useValue: {} },
      { provide: CreditNotesService, useValue: {} },
      {
        provide: NumberingService,
        useValue: { reserveNext: jest.fn().mockResolvedValue("RET-1") },
      },
    ],
  }).compile();
  return { service: mod.get(ReturnsService), txReturn };
}

const dto = (qty: number) => ({
  orderId: "ord-1",
  reason: "DAMAGED",
  items: [{ productId: "p1", qty }],
});

// A box-unaware 2-box line billed 1:1 by one invoice item whose split proves boxes (factor 12).
const boxLine = line({ unitsPerBox: 12 });
const boxInvoice = [{ orderItemId: "l1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }];

describe("ReturnsService.create — STANDARD return axis (B650/B754, SA-158)", () => {
  it("(i) box-unaware 2-box line on a 12-pack: cap is 24 pieces, the credit qty stays in boxes", async () => {
    const { service, txReturn } = await harness({ lineItems: [boxLine], invoiceItems: boxInvoice });
    await service.create(dto(1) as any, "user-1");
    expect(txReturn.create.mock.calls[0][0].data.items.create[0].qty).toBe(1); // line unit on disk
  });

  it("(i) over-return message reads in the line's unit: 3 boxes against 2", async () => {
    const { service, txReturn } = await harness({ lineItems: [boxLine], invoiceItems: boxInvoice });
    await expect(service.create(dto(3) as any, "user-1")).rejects.toThrow(
      /Return qty \(3\) exceeds remaining returnable qty \(2\)/,
    );
    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("(i) a prior return of 1 box leaves exactly 1 box (12 of 24 pieces)", async () => {
    const { service } = await harness({
      lineItems: [boxLine],
      invoiceItems: boxInvoice,
      priorStandard: [{ items: [{ productId: "p1", qty: 1 }] }],
    });
    await expect(service.create(dto(2) as any, "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.create(dto(1) as any, "user-1")).resolves.toBeDefined();
  });

  it("(ii) unit-aware Case line (qty 24 pieces, label + snapshot 1): factor 1, cap 24 of 24", async () => {
    const caseLine = line({ qty: 24, unitLabel: "Case", unitsPerBox: 1, boxes: 2, pieces: 0 });
    const { service } = await harness({ lineItems: [caseLine] });
    await expect(service.create(dto(24) as any, "user-1")).resolves.toBeDefined();
    await expect(service.create(dto(25) as any, "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("(iii) a box-unaware 12-pack line and a split line of one product: 409, nothing written", async () => {
    const split = line({ id: "l2", qty: 6, boxes: 0, pieces: 6, unitsPerBox: 12 });
    const { service, txReturn } = await harness({
      lineItems: [boxLine, split],
      invoiceItems: boxInvoice,
    });
    await expect(service.create(dto(1) as any, "user-1")).rejects.toBeInstanceOf(ConflictException);
    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("(v) a legacy line with no split, a stored pack and no invoice split: 409 unknown, never booked as pieces", async () => {
    const { service, txReturn } = await harness({ lineItems: [boxLine], invoiceItems: [] });
    await expect(service.create(dto(1) as any, "user-1")).rejects.toThrow(
      /quantity basis unknown for product p1/i,
    );
    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("a split line (factor 1) is unchanged: same cap, same qty on disk", async () => {
    const split = line({ qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 });
    const { service, txReturn } = await harness({ lineItems: [split] });
    await service.create(dto(30) as any, "user-1");
    expect(txReturn.create.mock.calls[0][0].data.items.create[0].qty).toBe(30);
    await expect(service.create(dto(31) as any, "user-1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("returnedPiecesByProduct — one axis (B671, SA-158)", () => {
  it("(iv) STANDARD 1 box (12-pack) + INLINE 5 pieces = 17 pieces, not 6", async () => {
    const tx: any = {
      return: {
        findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "p1", qty: 1 }] }]),
      },
      returnItem: { findMany: jest.fn().mockResolvedValue([{ productId: "p1", qty: 5 }]) },
      orderItem: { findMany: jest.fn().mockResolvedValue([boxLine]) },
      invoiceItem: { findMany: jest.fn().mockResolvedValue(boxInvoice) },
    };
    expect(await returnedPiecesByProduct(tx, "ord-1")).toEqual({ p1: 17 });
  });

  it("refuses (409) a prior STANDARD return whose product basis is now unknown", async () => {
    const tx: any = {
      return: {
        findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "p1", qty: 1 }] }]),
      },
      returnItem: { findMany: jest.fn().mockResolvedValue([]) },
      orderItem: { findMany: jest.fn().mockResolvedValue([boxLine]) },
      invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    await expect(returnedPiecesByProduct(tx, "ord-1")).rejects.toBeInstanceOf(ConflictException);
  });
});
