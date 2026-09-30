/**
 * W5c: the returns lifecycle drives the regulated sales ledger.
 * receive() reverses; cancel() (of a received return) un-reverses. Both run
 * inside the return's tenantTransaction so the ledger write is atomic with it.
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

describe("ReturnsService → regulated ledger (W5c)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { reverseReturnEntries: jest.Mock; unreverseReturnEntries: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: ledger },
        { provide: CreditNotesService, useValue: { create: jest.fn() } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("RET-2026-0001") },
        },
      ],
    }).compile();
    service = mod.get(ReturnsService);
    // Default: the concurrency claim wins (transition succeeds).
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
  });

  it("receive() reverses the ledger with a per-product returned-qty map", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      status: "IN_TRANSIT",
      orderId: "ord-1",
      items: [
        { productId: "p1", qty: 2, restock: false },
        { productId: "p1", qty: 1, restock: true }, // same product pooled
        { productId: "p2", qty: 5, restock: false },
      ],
    });

    await service.receive("ret-1", "user-1");

    expect(ledger.reverseReturnEntries).toHaveBeenCalledTimes(1);
    const arg = ledger.reverseReturnEntries.mock.calls[0][0];
    expect(arg.returnId).toBe("ret-1");
    expect(arg.orderId).toBe("ord-1");
    expect(arg.returnedByProduct.get("p1")).toBe(3); // 2 + 1 pooled
    expect(arg.returnedByProduct.get("p2")).toBe(5);
    expect(arg.db).toBeDefined(); // the tx client
  });

  it("cancel() of a RECEIVED return un-reverses the ledger", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      status: "RECEIVED",
      orderId: "ord-1",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2, restock: false }],
    });

    await service.cancel("ret-1", { sub: "u1", role: "OPERATOR" } as any);

    expect(ledger.unreverseReturnEntries).toHaveBeenCalledWith(
      expect.objectContaining({ returnId: "ret-1" }),
    );
  });

  it("cancel() of a not-yet-received return does NOT touch the ledger", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      status: "APPROVED",
      orderId: "ord-1",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2, restock: false }],
    });

    await service.cancel("ret-1", { sub: "u1", role: "OPERATOR" } as any);

    expect(ledger.unreverseReturnEntries).not.toHaveBeenCalled();
  });

  it("F2 (independent review, PR-2): cancel() of a PROCESSED return DOES un-reverse the ledger — legacy rows still need their effects undone", async () => {
    // B348 removed this arm on the theory that no writer sets PROCESSED — true for CODE, not
    // for pre-existing DATA. PROCESSED is a legacy ReturnStatus (still a live sales.prisma enum
    // member): a return already sitting in that state from before whatever retired the writer
    // must still have cancel() undo its stock/ledger effects, or the reversal is stranded.
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      status: "PROCESSED",
      orderId: "ord-1",
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 2, restock: false }],
    });

    await service.cancel("ret-1", { sub: "u1", role: "OPERATOR" } as any);

    expect(ledger.unreverseReturnEntries).toHaveBeenCalledWith(
      expect.objectContaining({ returnId: "ret-1" }),
    );
  });

  it("receive() aborts without reversing when the IN_TRANSIT claim loses the race", async () => {
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      status: "IN_TRANSIT", // stale read; a concurrent receive already claimed it
      orderId: "ord-1",
      items: [{ productId: "p1", qty: 1, restock: false }],
    });
    prisma.return.updateMany.mockResolvedValue({ count: 0 }); // claim matched 0 rows

    await expect(service.receive("ret-1", "u1")).rejects.toBeInstanceOf(BadRequestException);
    expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
  });
});
