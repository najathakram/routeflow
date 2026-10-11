/**
 * B848 (a sibling of SA-737): a STANDARD return's receive() books a pro-rated reversal of the regulated sales ledger from the
 * order's per-line remaining balances. Two receives on one order (or a receive beside a void, a cancel or a refund of that
 * order) must not read the same balance, so receive() takes the ORDER row lock, after the Return claim, in the house order
 * Return -> Order, before the restock and the ledger reversal. Row locks only, no second in-process lock.
 *
 * Mocked here (statement order). The real-Postgres wait is in returns-receive-order-lock-b848.db.spec.ts.
 */
import { Test } from "@nestjs/testing";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReturnsService.receive: the Order row lock (B848)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { reverseReturnEntries: jest.Mock; unreverseReturnEntries: jest.Mock };
  let events: string[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    events = [];
    ledger = {
      reverseReturnEntries: jest.fn(async () => {
        events.push("ledger");
      }),
      unreverseReturnEntries: jest.fn(),
    };
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join("?").replace(/\s+/g, " ").trim();
          events.push(/FROM "Order"/.test(text) ? `order-lock:${String(values[0])}` : text);
          return Promise.resolve(0);
        }),
      }),
    );
    prisma.return.updateMany.mockImplementation(async () => {
      events.push("claim");
      return { count: 1 };
    });
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      status: "IN_TRANSIT",
      kind: "STANDARD",
      orderId: "ord-1",
      items: [{ productId: "p1", qty: 2, restock: false }],
    });
    const mod = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: ledger },
        { provide: CreditNotesService, useValue: { create: jest.fn() } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
  });

  it("locks the order after the Return claim and before the ledger reversal", async () => {
    await service.receive("ret-1", "user-1");
    expect(events).toEqual(["claim", "order-lock:ord-1", "ledger"]);
  });

  it("the order lock is a tenant-bound FOR UPDATE on the return's own order", async () => {
    const texts: string[] = [];
    const base = prisma.tenantTransaction.getMockImplementation()!;
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      base((tx: any) =>
        fn({
          ...tx,
          $executeRaw: jest.fn((strings: TemplateStringsArray) => {
            texts.push(strings.join("?").replace(/\s+/g, " ").trim());
            return Promise.resolve(0);
          }),
        }),
      ),
    );
    await service.receive("ret-1", "user-1");
    expect(texts).toEqual([
      expect.stringMatching(/FROM "Order" WHERE id = \? AND .*"tenantId" = \?\) FOR UPDATE/),
    ]);
  });

  it("a receive that loses the claim takes no order lock and reverses nothing", async () => {
    prisma.return.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.receive("ret-1", "user-1")).rejects.toThrow(/can be received/);
    expect(events).toEqual([]);
    expect(ledger.reverseReturnEntries).not.toHaveBeenCalled();
  });
});
