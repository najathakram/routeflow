/**
 * P5-13 WP5: ReturnsService.processRefund() — approving a return's refund creates a
 * lump-sum store credit (no line items — the regulated ledger was already reversed
 * at receive()). Refund value = Σ returned qty × the order line's EFFECTIVE
 * per-unit price (subtotal ÷ qty, boxed-safe — NOT qty × unitPrice).
 *
 * WP9 (2026-07-30): processRefund(id, dto?) now folds a CREDIT_NOTE | EXTERNAL_REFUND
 * method choice into the SAME atomic RECEIVED→REFUNDED claim (refundMethod/refundAmount/
 * refundedAt persist in one write), and receive() accepts APPROVED as well as IN_TRANSIT
 * and can suppress restocking via { restock: false }.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
  let ledger: { reverseReturnEntries: jest.Mock; unreverseReturnEntries: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn();
    ledger = { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: ledger },
        { provide: CreditNotesService, useValue: { create: creditNotesCreate } },
      ],
    }).compile();

    service = mod.get(ReturnsService);
  });

  it("no body: defaults to CREDIT_NOTE, mints Σ qty × (subtotal ÷ qty) — NOT qty × unitPrice — and persists the resolution snapshot", async () => {
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

    // The RECEIVED→REFUNDED flip is an atomic conditional claim (updateMany) that ALSO
    // persists the resolution snapshot in the same write, so a concurrent double-refund
    // can't mint two credits or record two resolutions; update() is only the linkage.
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-1", status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        refundAmount: 20,
        refundedAt: expect.any(Date),
      },
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

  it("F09 A2: refund against a voided source mints an unsourced credit note", async () => {
    // The order's only invoice was VOID. The live-source select (CREDIT_SOURCE_EXCLUDED)
    // filters it out at the DB, so `order.invoices` comes back empty here — exactly like
    // the pre-fix code otherwise reaching create()'s guard AFTER the RECEIVED->REFUNDED
    // claim already committed, which threw and lost the refund with no recovery path.
    // With the fix, zero live invoices takes the same branch as 2+ invoices: undefined
    // invoiceId, credit minted unsourced, and processRefund resolves normally.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-12",
      returnNumber: "RET-2026-012",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-012",
        invoices: [], // the sole invoice was VOID and excluded by the live-source filter
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-12",
      status: "REFUNDED",
      creditNoteId: "cn-12",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-12", creditNoteNumber: "CN-2026-0012" });

    const result = await service.processRefund("ret-12");

    expect(creditNotesCreate).toHaveBeenCalledTimes(1);
    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.invoiceId).toBeUndefined();
    expect(prisma.return.update).toHaveBeenCalledWith({
      where: { id: "ret-12" },
      data: { creditNoteId: "cn-12" },
    });
    expect(result.creditNoteId).toBe("cn-12");
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
      data: {
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        refundAmount: 0,
        refundedAt: expect.any(Date),
      },
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

  it("rounds refundAmount to the cent on a box-priced fixture", async () => {
    // Order line: qty 3, subtotal 10 -> effective per-unit = 3.333...; returning 2 units
    // gives a raw refund of 6.6666...7, which must round half-up to 6.67.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-11",
      returnNumber: "RET-2026-011",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-011",
        invoices: [{ id: "inv-1" }],
        lineItems: [{ productId: "p1", qty: 3, unitPrice: 4, subtotal: 10 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({
      id: "ret-11",
      status: "REFUNDED",
      creditNoteId: "cn-11",
    });
    creditNotesCreate.mockResolvedValue({ id: "cn-11", creditNoteNumber: "CN-2026-0011" });

    await service.processRefund("ret-11");

    const dto = creditNotesCreate.mock.calls[0][0];
    expect(dto.amount).toBe(6.67);
  });

  // ─── WP9: method choice — CREDIT_NOTE vs EXTERNAL_REFUND ────────────────────────

  it("{ method: 'EXTERNAL_REFUND' } records the resolution but mints no credit note", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-9",
      returnNumber: "RET-2026-009",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-009",
        invoices: [{ id: "inv-1" }],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.processRefund("ret-9", { method: "EXTERNAL_REFUND" });

    expect(creditNotesCreate).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: { id: "ret-9", status: "RECEIVED" },
      data: {
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 20,
        refundedAt: expect.any(Date),
      },
    });
    expect(prisma.return.update).not.toHaveBeenCalled(); // no creditNoteId written
    expect(result).not.toHaveProperty("creditNoteId");
  });

  it("aborts an EXTERNAL_REFUND without recording anything when the atomic claim is lost (count 0)", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-10",
      returnNumber: "RET-2026-010",
      status: "RECEIVED",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2 }],
      order: {
        orderNumber: "ORD-010",
        invoices: [{ id: "inv-1" }],
        lineItems: [{ productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 }],
      },
    });
    prisma.return.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.processRefund("ret-10", { method: "EXTERNAL_REFUND" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(creditNotesCreate).not.toHaveBeenCalled();
  });

  // ─── WP9: receive() accepts APPROVED as well as IN_TRANSIT, and can skip restocking ──

  describe("receive()", () => {
    it("is allowed from APPROVED (resolve-without-transit)", async () => {
      prisma.return.findUnique.mockResolvedValue({
        id: "ret-6",
        status: "APPROVED",
        orderId: "ord-6",
        items: [{ productId: "p1", qty: 2, restock: true }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });
      // Decimal columns, not JS numbers — receive() calls .add() on currentStock.
      prisma.product.findUnique.mockResolvedValue({
        currentStock: new Prisma.Decimal(10),
        averageCost: new Prisma.Decimal(5),
      });

      await service.receive("ret-6", "user-1");

      expect(prisma.return.updateMany).toHaveBeenCalledWith({
        where: { id: "ret-6", status: { in: ["APPROVED", "IN_TRANSIT"] } },
        data: { status: "RECEIVED" },
      });
    });

    it("rejects a PENDING return before claiming", async () => {
      prisma.return.findUnique.mockResolvedValue({
        id: "ret-7",
        status: "PENDING",
        orderId: "ord-7",
        items: [],
      });

      await expect(service.receive("ret-7", "user-1")).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("{ restock: false } skips ALL restocking, persists restock:false on every item, and still reverses the regulated ledger", async () => {
      prisma.return.findUnique.mockResolvedValue({
        id: "ret-8",
        status: "IN_TRANSIT",
        orderId: "ord-8",
        items: [{ productId: "p1", qty: 2, restock: true }],
      });
      prisma.return.updateMany.mockResolvedValue({ count: 1 });

      await service.receive("ret-8", "user-1", { restock: false });

      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.returnItem.updateMany).toHaveBeenCalledWith({
        where: { returnId: "ret-8" },
        data: { restock: false },
      });
      expect(ledger.reverseReturnEntries).toHaveBeenCalledTimes(1);
    });
  });
});
