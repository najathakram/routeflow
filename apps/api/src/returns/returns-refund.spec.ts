/**
 * P5-13 WP5: ReturnsService.processRefund() — approving a return's refund creates a
 * lump-sum store credit (no line items — the regulated ledger was already reversed
 * at receive()). Refund value = Σ returned qty × the order line's EFFECTIVE
 * per-unit price (subtotal ÷ qty, boxed-safe — NOT qty × unitPrice).
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReturnsService.processRefund → dispute creates a store credit (P5-13 WP5)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn();

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() },
        },
        { provide: CreditNotesService, useValue: { create: creditNotesCreate } },
      ],
    }).compile();

    service = mod.get(ReturnsService);
  });

  it("creates a lump-sum credit for Σ qty × (subtotal ÷ qty) — NOT qty × unitPrice — and links creditNoteId", async () => {
    // Order line: qty 10, subtotal 100 → effective per-unit = 10 (unitPrice 15 is a
    // decoy box price; using it instead would wrongly yield 2 × 15 = 30).
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      returnNumber: "RET-2026-001",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-001",
        invoices: [{ id: "inv-1" }],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 }); // atomic RECEIVED→REFUNDED claim
    prisma.return.update.mockResolvedValue({
      id: "ret-1",
      status: "REFUNDED",
      creditNoteId: "cn-1",
    }); // the linkage write
    creditNotesCreate.mockResolvedValue({ id: "cn-1", creditNoteNumber: "CN-2026-0001" });

    const result = await service.processRefund("ret-1");

    expect(creditNotesCreate).toHaveBeenCalledTimes(1);
    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.customerId).toBe("cust-1");
    expect(dto.invoiceId).toBe("inv-1");
    expect(dto.amount).toBe(20); // 2 × (100 / 10), not 2 × 15
    expect(dto.items).toBeUndefined(); // lump-sum — no line linkage
    expect(dto.reason).toContain("RET-2026-001");

    // The RECEIVED→REFUNDED flip is an atomic conditional claim (updateMany), so a
    // concurrent double-refund can't mint two credits; update() is only the linkage.
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-1", status: "RECEIVED" },
      data: { status: "REFUNDED" },
    });
    expect(prisma.return.update).toHaveBeenCalledTimes(1);
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: "ret-1" },
      data: { creditNoteId: "cn-1" },
    });
    expect(result.creditNoteId).toBe("cn-1");
  });

  it("omits invoiceId when the order has 2+ invoices (standalone credit)", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-2",
      returnNumber: "RET-2026-002",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 1 }],
      order: {
        orderNumber: "ORD-002",
        invoices: [{ id: "inv-1" }, { id: "inv-2" }],
        lineItems: [{ productId: "p1", qty: 5, unitPrice: 20, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({ id: "ret-2", status: "REFUNDED" });
    creditNotesCreate.mockResolvedValue({ id: "cn-2", creditNoteNumber: "CN-2026-0002" });

    await service.processRefund("ret-2");

    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.invoiceId).toBeUndefined();
  });

  it("skips credit creation for a $0 refund (no matching items) but still flips REFUNDED", async () => {
    prisma.return.findUnique
      .mockResolvedValueOnce({
        id: "ret-3",
        returnNumber: "RET-2026-003",
        status: "RECEIVED",
        customerId: "cust-1",
        items: [{ productId: "p-not-on-order", qty: 3 }],
        order: {
          orderNumber: "ORD-003",
          invoices: [{ id: "inv-1" }],
          lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
        },
      })
      .mockResolvedValueOnce({ id: "ret-3", status: "REFUNDED" }); // refetch after the claim
    prisma.return.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.processRefund("ret-3");

    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-3", status: "RECEIVED" },
      data: { status: "REFUNDED" },
    });
    expect(prisma.return.update).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "ret-3", status: "REFUNDED" });
  });

  it("rejects a non-RECEIVED return before any money math", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-4",
      returnNumber: "RET-2026-004",
      status: "APPROVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-004",
        invoices: [{ id: "inv-1" }],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });

    await expect(service.processRefund("ret-4")).rejects.toBeInstanceOf(BadRequestException);
    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.update).not.toHaveBeenCalled();
  });

  it("aborts without minting a credit when the atomic claim is lost (count 0)", async () => {
    // A concurrent processRefund already flipped RECEIVED→REFUNDED, so this claim
    // matches 0 rows. Without the guard both invocations would each mint a store
    // credit — double-crediting the customer.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-5",
      returnNumber: "RET-2026-005",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-005",
        invoices: [{ id: "inv-1" }],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.processRefund("ret-5")).rejects.toBeInstanceOf(BadRequestException);
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });
});
