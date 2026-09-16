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

  it("findOne refuses an INLINE return", async () => {
    prisma.return.findUnique.mockResolvedValue({
      ...inlineReturn,
      items: [],
      order: null,
      customer: { id: "cust-1", businessName: "Acme Co" },
    } as any);
    await expect(service.findOne("ret-inline-1")).rejects.toThrow(
      "INLINE_RETURN_USE_INLINE_ENDPOINTS",
    );
  });

  it("findAll always scopes to kind: STANDARD — an INLINE return has its own list surface", async () => {
    prisma.return.findMany.mockResolvedValue([]);
    await service.findAll({});
    expect(prisma.return.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ kind: "STANDARD" }) }),
    );
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
