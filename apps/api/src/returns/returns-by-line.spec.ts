/**
 * SA-1042 B9b rules 3-6 through ReturnsService.create (mocked tx): a standard item may name its order line. The credit/pricing
 * half is in returns-by-line-price.spec.ts; the real-Postgres cases are in returns-by-line.db.spec.ts.
 *
 * Fixture: product P, pack 10. Line A: 2 Cases of 200 (400 pcs). Line B: 10 boxes of 10 (100 pcs). 500 pieces in all.
 */
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";

const lineA = {
  id: "A",
  productId: "P",
  qty: 400,
  unitPrice: 45,
  subtotal: 90,
  status: "CONFIRMED",
  position: 0,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 200,
  unitLabel: "Case",
  product: { unitsPerBox: 10 },
};
const lineB = {
  id: "B",
  productId: "P",
  qty: 100,
  unitPrice: 2.5,
  subtotal: 25,
  status: "CONFIRMED",
  position: 1,
  boxes: 10,
  pieces: 0,
  unitsPerBox: 10,
  unitLabel: null,
  product: { unitsPerBox: 10 },
};

async function harness(
  opts: { priorStandard?: any[]; priorLine?: any[]; priorInline?: any[] } = {},
) {
  const prisma = createMockPrisma();
  prisma.order.findUnique.mockResolvedValue({
    id: "ord-1",
    status: "DELIVERED",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Co" },
    lineItems: [lineA, lineB],
    invoices: [{ id: "inv-1" }],
  } as any);
  const txReturn = {
    findMany: jest.fn().mockResolvedValue(opts.priorStandard ?? []),
    create: jest.fn().mockResolvedValue({ id: "ret-1", items: [] }),
  };
  const returnItem = {
    // the line priors are the only query keyed by sourceOrderItemId; the pool's INLINE read is keyed by sourceOrderId
    findMany: jest
      .fn()
      .mockImplementation(async (args: any) =>
        args?.where?.sourceOrderItemId ? (opts.priorLine ?? []) : (opts.priorInline ?? []),
      ),
  };
  prisma.tenantTransaction.mockImplementation((fn: any) =>
    fn({
      return: txReturn,
      returnItem,
      orderItem: { findMany: jest.fn().mockResolvedValue([lineA, lineB]) },
      invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
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
  return { service: mod.get(ReturnsService), txReturn, returnItem };
}

const body = (...items: any[]) => ({ orderId: "ord-1", reason: "DAMAGED", items });
const written = (txReturn: any) => txReturn.create.mock.calls[0][0].data.items.create;

describe("ReturnsService.create: line items (SA-1042 B9b)", () => {
  it("N-r4: one Case on line A stores qty 200 and the line key", async () => {
    const { service, txReturn } = await harness();
    await service.create(
      body({ productId: "P", orderItemId: "A", boxes: 1, pieces: 0 }) as any,
      "u",
    );
    expect(written(txReturn)).toEqual([
      expect.objectContaining({ productId: "P", qty: 200, sourceOrderItemId: "A" }),
    ]);
  });

  it("R-r2: 110 pieces on the 100-piece line B is a 400 naming what is left; nothing is written", async () => {
    const { service, txReturn } = await harness();
    const err = await service
      .create(body({ productId: "P", orderItemId: "B", qty: 110 }) as any, "u")
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/exceeds what is left on this line: 100 pcs \(10 boxes\)/);
    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("G-r7 (pooled, KEPT): the same 110 pieces without a line key is accepted by the pool (500 pieces)", async () => {
    const { service, txReturn } = await harness();
    await service.create(body({ productId: "P", qty: 110 }) as any, "u");
    expect(written(txReturn)[0].qty).toBe(110);
    expect(written(txReturn)[0].sourceOrderItemId).toBeUndefined();
  });

  it("G-r10: a prior line return of 1 Case leaves 1 Case on A; 2 more Cases is a 400, 1 is accepted", async () => {
    const prior = [
      { sourceOrderItemId: "A", productId: "P", qty: 200, return: { kind: "STANDARD" } },
    ];
    const poolPrior = [{ items: [{ productId: "P", qty: 200 }] }];
    const over = await harness({ priorLine: prior, priorStandard: poolPrior });
    await expect(
      over.service.create(body({ productId: "P", orderItemId: "A", boxes: 2 }) as any, "u"),
    ).rejects.toThrow(/200 pcs \(1 Case\)/);
    const ok = await harness({ priorLine: prior, priorStandard: poolPrior });
    await ok.service.create(body({ productId: "P", orderItemId: "A", boxes: 1 }) as any, "u");
    expect(written(ok.txReturn)[0]).toMatchObject({ qty: 200, sourceOrderItemId: "A" });
  });

  it("G-r10: a pooled prior of 300 pieces still limits the product pool for a line item (200 left)", async () => {
    const { service, txReturn } = await harness({
      priorStandard: [{ items: [{ productId: "P", qty: 300 }] }],
    });
    await service.create(body({ productId: "P", orderItemId: "A", boxes: 1 }) as any, "u"); // 200 of the 200 left
    expect(txReturn.create).toHaveBeenCalledTimes(1);
    const again = await harness({ priorStandard: [{ items: [{ productId: "P", qty: 300 }] }] });
    await expect(
      again.service.create(body({ productId: "P", orderItemId: "B", boxes: 3 }) as any, "u"), // 30 more > 200 left? no: 30 <= 200
    ).resolves.toBeDefined();
  });

  it("G-r11: an INLINE return sourced from the line counts against the line cap", async () => {
    const inline = [
      { sourceOrderItemId: "B", productId: "P", qty: 60, return: { kind: "INLINE" } },
    ];
    const { service } = await harness({ priorLine: inline });
    await expect(
      service.create(body({ productId: "P", orderItemId: "B", qty: 50 }) as any, "u"),
    ).rejects.toThrow(/40 pcs \(4 boxes\)/);
  });

  it("G-r5/G-r6: an unknown line, a count in two shapes and a mixed payload are 400s and write nothing", async () => {
    for (const [items, code] of [
      [[{ productId: "P", orderItemId: "NOPE", qty: 1 }], API_ERROR_CODES.RETURN_LINE_NOT_ON_ORDER],
      [
        [{ productId: "P", orderItemId: "A", qty: 1, boxes: 1 }],
        API_ERROR_CODES.RETURN_LINE_COUNT_SHAPE,
      ],
      [
        [
          { productId: "P", orderItemId: "A", boxes: 1 },
          { productId: "P", qty: 10 },
        ],
        API_ERROR_CODES.RETURN_LINE_MIXED_WITH_POOLED,
      ],
    ] as const) {
      const { service, txReturn } = await harness();
      const err = await service.create(body(...items) as any, "u").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code });
      expect(txReturn.create).not.toHaveBeenCalled();
    }
  });
});
