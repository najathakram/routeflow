/**
 * PR-1a (Returns Inside Order Creation, schema + shared readers) — §2.3: every
 * standard-path method refuses an INLINE-kind return with
 * INLINE_RETURN_USE_INLINE_ENDPOINTS. No INLINE return can be minted until
 * PR-1c/1d ships its own endpoints — these rows are seeded directly (as the
 * eventual capture flow will write them) to prove the refusal now, ahead of
 * that flow existing, so it can never regress once it does.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReturnsService — kind branch (M6/§2.3): every standard-path method refuses INLINE", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const inlineReturn = {
    id: "ret-inline-1",
    kind: "INLINE",
    status: "PENDING",
    customerId: "cust-1",
    items: [],
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
  });

  it("approve refuses an INLINE return", async () => {
    prisma.return.findUnique.mockResolvedValue({ ...inlineReturn, status: "PENDING" } as any);
    await expect(service.approve("ret-inline-1")).rejects.toThrow(
      "INLINE_RETURN_USE_INLINE_ENDPOINTS",
    );
  });

  it("reject refuses an INLINE return", async () => {
    prisma.return.findUnique.mockResolvedValue({ ...inlineReturn, status: "PENDING" } as any);
    await expect(service.reject("ret-inline-1")).rejects.toThrow(
      "INLINE_RETURN_USE_INLINE_ENDPOINTS",
    );
  });

  it("markInTransit refuses an INLINE return", async () => {
    prisma.return.findUnique.mockResolvedValue({ ...inlineReturn, status: "APPROVED" } as any);
    await expect(service.markInTransit("ret-inline-1")).rejects.toThrow(
      "INLINE_RETURN_USE_INLINE_ENDPOINTS",
    );
  });

  it("receive refuses an INLINE return", async () => {
    prisma.return.findUnique.mockResolvedValue({ ...inlineReturn, status: "APPROVED" } as any);
    await expect(service.receive("ret-inline-1", "user-1")).rejects.toThrow(
      "INLINE_RETURN_USE_INLINE_ENDPOINTS",
    );
  });

  it("processRefund refuses an INLINE return", async () => {
    prisma.return.findUnique.mockResolvedValue({ ...inlineReturn, status: "RECEIVED" } as any);
    await expect(service.processRefund("ret-inline-1")).rejects.toThrow(
      "INLINE_RETURN_USE_INLINE_ENDPOINTS",
    );
  });

  it("cancel refuses an INLINE return for OPERATOR", async () => {
    prisma.return.findUnique.mockResolvedValue({ ...inlineReturn, status: "PENDING" } as any);
    await expect(
      service.cancel("ret-inline-1", { sub: "u1", role: "OPERATOR" } as any),
    ).rejects.toThrow("INLINE_RETURN_USE_INLINE_ENDPOINTS");
  });

  it("cancel refuses an INLINE return for CUSTOMER too (the refusal runs before the ownership check)", async () => {
    prisma.return.findUnique.mockResolvedValue({ ...inlineReturn, status: "PENDING" } as any);
    await expect(
      service.cancel("ret-inline-1", { sub: "u1", role: "CUSTOMER" } as any),
    ).rejects.toThrow("INLINE_RETURN_USE_INLINE_ENDPOINTS");
  });

  // #2406 (SA-484c): findOne now RENDERS an INLINE row (the order-detail panel links to it) —
  // it no longer throws; it skips priceReturn() and reports refundEstimateReason "INLINE".
  it("findOne renders an INLINE return, skipping priceReturn", async () => {
    prisma.return.findUnique.mockResolvedValue({
      ...inlineReturn,
      refundAmount: "14.97",
      items: [],
      order: null,
      customer: { id: "cust-1", businessName: "Acme Co" },
    } as any);
    const spy = jest.spyOn(service as any, "priceReturn");
    const result = await service.findOne("ret-inline-1");
    expect(result.refundEstimate).toBeNull();
    expect(result.refundEstimateReason).toBe("INLINE");
    expect(spy).not.toHaveBeenCalled();
  });

  it("findAll defaults to kind: STANDARD — an INLINE return has its own list surface unless opted in", async () => {
    prisma.return.findMany.mockResolvedValue([]);
    await service.findAll({});
    expect(prisma.return.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: "STANDARD" }) }),
    );
  });

  it("findAll kind: INLINE scopes to where.kind INLINE", async () => {
    prisma.return.findMany.mockResolvedValue([]);
    await service.findAll({ kind: "INLINE" });
    expect(prisma.return.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: "INLINE" }) }),
    );
  });

  it("findAll kind: ALL drops the kind key from where entirely", async () => {
    prisma.return.findMany.mockResolvedValue([]);
    await service.findAll({ kind: "ALL" });
    const call = prisma.return.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("kind");
  });

  it("findAll: an INLINE row in the result skips priceReturn, refundEstimate null, refundAmount passed through", async () => {
    prisma.return.findMany.mockResolvedValue([
      { id: "ret-inline-2", kind: "INLINE", refundAmount: "14.97", items: [], order: null },
    ] as any);
    prisma.return.count.mockResolvedValue(1);
    const spy = jest.spyOn(service as any, "priceReturn");
    const { data } = await service.findAll({ kind: "ALL" });
    expect(spy).not.toHaveBeenCalled();
    expect(data[0].refundEstimate).toBeNull();
    expect(data[0].refundEstimateReason).toBe("INLINE");
    expect(data[0].refundAmount).toBe("14.97");
  });

  it("findAll: a STANDARD row is still enriched via priceReturn", async () => {
    prisma.return.findMany.mockResolvedValue([
      { id: "ret-std-1", kind: "STANDARD", items: [], order: null },
    ] as any);
    prisma.return.count.mockResolvedValue(1);
    const spy = jest.spyOn(service as any, "priceReturn");
    const { data } = await service.findAll({});
    expect(spy).toHaveBeenCalledWith([], undefined, expect.any(Map));
    expect(data[0].refundEstimateReason).not.toBe("INLINE");
  });

  it("create always writes kind: STANDARD explicitly", async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: "ord-1",
      status: "DELIVERED",
      customerId: "cust-1",
      customer: { id: "cust-1", businessName: "Acme Co" },
      lineItems: [{ productId: "p1", qty: 10, unitPrice: 5, status: "PENDING" }],
      invoices: [],
    } as any);
    const txReturn = {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: "ret-1", items: [] }),
    };
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        return: txReturn,
        returnItem: { findMany: jest.fn().mockResolvedValue([]) },
        order: prisma.order,
        customer: prisma.customer,
        $executeRaw: jest.fn().mockResolvedValue(0),
        $queryRaw: jest.fn(),
      }),
    );

    await service.create(
      { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 1 }] },
      "user-1",
    );

    expect(txReturn.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: "STANDARD" }) }),
    );
  });
});
