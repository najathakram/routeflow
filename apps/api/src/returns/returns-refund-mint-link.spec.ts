/**
 * SA-773 row 333(a), the caller's half: a STANDARD store-credit refund hands the mint the return id for EVERY shape (not only the
 * pooled one), so the link is written inside the mint transaction; there is no second, after-the-commit write of
 * `creditNoteId` for a crash to fall between.
 */
import { Test } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReturnsService.processRefund (store credit): the credit note link belongs to the mint transaction (row 333a)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn().mockResolvedValue({ id: "cn-1" });
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({ ...prisma, $executeRaw: jest.fn().mockResolvedValue(0) }),
    );
    prisma.invoice.findMany.mockImplementation(async ({ where }: any) =>
      where?.id?.in
        ? [
            {
              id: "inv-1",
              status: "SENT",
              total: 100,
              payments: [{ amount: 100, status: "PAID", method: "CASH" }],
            },
          ]
        : [{ id: "inv-1" }],
    );
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({});
    prisma.return.findFirst.mockResolvedValue({
      id: "ret-1",
      status: "RECEIVED",
      kind: "STANDARD",
    });
    prisma.return.findUnique.mockImplementation(async (args: any) =>
      args?.include?.order
        ? {
            id: "ret-1",
            returnNumber: "RET-1",
            status: "RECEIVED",
            kind: "STANDARD",
            customerId: "cust-1",
            orderId: "ord-1",
            items: [{ productId: "p1", qty: 2 }],
            order: {
              id: "ord-1",
              orderNumber: "ORD-1",
              counterSale: false,
              registerKey: null,
              invoices: [
                {
                  id: "inv-1",
                  invoiceNumber: "N-1",
                  status: "SENT",
                  total: 100,
                  items: [{ productId: "p1", qty: 10, subtotal: 100 }],
                },
              ],
              lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
            },
          }
        : { id: "ret-1", status: "REFUNDED", refundAmount: 20 },
    );
    const mod = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: { reverseReturnEntries: jest.fn() } },
        { provide: CreditNotesService, useValue: { create: creditNotesCreate } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
  });

  it("a single-invoice refund passes the return id to the mint (it was passed only for the pooled shape)", async () => {
    await service.processRefund("ret-1", { method: "CREDIT_NOTE" } as any);
    expect(creditNotesCreate).toHaveBeenCalledTimes(1);
    expect(creditNotesCreate.mock.calls[0][1]).toMatchObject({
      ledgerReversedByReturn: true,
      returnId: "ret-1",
    });
  });

  it("there is no after-the-commit write of creditNoteId: the mint links, the refund only reads the row back", async () => {
    await service.processRefund("ret-1", { method: "CREDIT_NOTE" } as any);
    expect(prisma.return.update).not.toHaveBeenCalled();
    const linkWrites = prisma.return.updateMany.mock.calls.filter(
      ([a]: any[]) => a?.data?.creditNoteId !== undefined,
    );
    expect(linkWrites).toEqual([]);
  });

  it("a mint that fails is still compensated back to RECEIVED while no credit note is linked (B68 unchanged)", async () => {
    creditNotesCreate.mockRejectedValue(new Error("boom"));
    await service.processRefund("ret-1", { method: "CREDIT_NOTE" } as any).catch(() => undefined);
    expect(prisma.return.updateMany).toHaveBeenLastCalledWith({
      where: { id: "ret-1", status: "REFUNDED", creditNoteId: null },
      data: { status: "RECEIVED", refundMethod: null, refundAmount: null, refundedAt: null },
    });
  });
});
