/**
 * B965 (SA-628l): `create()` already REFUSES a STANDARD return of a product sold on lines with different pack factors
 * (2 boxes of 12 + 12 loose pieces): 409, "return it inline, per line", nothing written. This pins it as the first line of
 * defence; the refund door (returns-mixed-unit-b965.spec.ts) is the net for legacy RECEIVED rows.
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

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

// a box-unaware 2-box line proven factor 12 by its one invoice item, beside a loose 12-piece line (own split: factor 1)
const boxLine = line({ unitsPerBox: 12 });
const looseLine = line({
  id: "l2",
  qty: 12,
  unitPrice: 5,
  subtotal: 60,
  position: 1,
  boxes: 0,
  pieces: 12,
  unitsPerBox: 12,
});
const boxInvoice = [{ orderItemId: "l1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }];

describe("ReturnsService.create — mixed pack factors are refused (B965)", () => {
  it.each([1, 2, 13, 14])(
    "a standard return of %s of a 2-box + 12-piece product is 409 and nothing is written",
    async (qty) => {
      const { service, txReturn } = await harness({
        lineItems: [boxLine, looseLine],
        invoiceItems: boxInvoice,
      });
      const err = await service.create(dto(qty) as any, "user-1").catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/different pack sizes/);
      expect(err.message).toMatch(/inline, per line/);
      expect(txReturn.create).not.toHaveBeenCalled();
    },
  );

  it("each single-factor shape of the same product is unchanged (boxed alone, loose alone)", async () => {
    const boxed = await harness({ lineItems: [boxLine], invoiceItems: boxInvoice });
    await boxed.service.create(dto(1) as any, "user-1");
    expect(boxed.txReturn.create).toHaveBeenCalledTimes(1);
    const loose = await harness({ lineItems: [looseLine] });
    await loose.service.create(dto(6) as any, "user-1");
    expect(loose.txReturn.create).toHaveBeenCalledTimes(1);
  });
});
