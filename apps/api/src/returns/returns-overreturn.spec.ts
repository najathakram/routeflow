/**
 * B10: ReturnsService.create() over-return / double-refund race.
 *
 * Before the fix, the cumulative-qty read (existingReturns), the validation, and
 * the return create() were three separate statements with no transaction and no
 * lock. Under READ COMMITTED, two concurrent creates for the same order could
 * both read the same "already returned" snapshot, both pass the remaining-qty
 * check, and both commit — over-returning the order, and (once each return was
 * independently refunded) paying the customer twice for the same goods.
 *
 * The fix wraps the read, the cumulative-qty validation, and the create inside a
 * single `this.prisma.tenantTransaction(...)` call that FIRST takes a
 * `SELECT ... FOR UPDATE` row lock on the order (the transaction alone is not
 * enough — tenantTransaction runs at READ COMMITTED, where both racers still see
 * a snapshot without the other's uncommitted insert), re-validating against a
 * fresh read taken from the SAME transaction client immediately before the create.
 * It also accumulates each validated line into the running total, so a single
 * payload repeating one productId can no longer over-return with no race at all.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ReturnsService.create → cumulative over-return / double-refund race (B10)", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  // A `return` model surface with its OWN jest.fn refs, deliberately distinct from
  // prisma.forTenant().return, standing in for the transaction client `tx`. If the
  // service ever regresses to reading/creating against the plain forTenant()
  // client instead of `tx`, these mocks go uncalled and the assertions below fail.
  let txReturn: { findMany: jest.Mock; create: jest.Mock };
  let txExecuteRaw: jest.Mock;

  const order = {
    id: "ord-1",
    status: "DELIVERED",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Co" },
    lineItems: [{ productId: "p1", qty: 10, unitPrice: 5 }],
    invoices: [{ id: "inv-1" }],
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.order.findUnique.mockResolvedValue(order as any);

    txReturn = { findMany: jest.fn(), create: jest.fn() };
    txExecuteRaw = jest.fn().mockResolvedValue(0);
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({ return: txReturn, $executeRaw: txExecuteRaw, $queryRaw: jest.fn() }),
    );

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
      ],
    }).compile();

    service = mod.get(ReturnsService);
  });

  it("throws 400 and creates nothing when the requested qty exceeds the ordered qty", async () => {
    txReturn.findMany.mockResolvedValue([]); // no prior returns on this order

    await expect(
      service.create(
        { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 11 }] },
        "user-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("throws 400 when a prior (non-REJECTED) return already consumed the remaining qty", async () => {
    // 10 ordered, 6 already returned → only 4 remain; requesting 5 must fail.
    txReturn.findMany.mockResolvedValue([{ items: [{ productId: "p1", qty: 6 }] }]);

    await expect(
      service.create(
        { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 5 }] },
        "user-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("ignores a REJECTED return's qty when computing remaining (findMany filters status != REJECTED)", async () => {
    // The transaction's read itself excludes REJECTED returns — assert the query
    // shape didn't change when it moved onto `tx`.
    txReturn.findMany.mockResolvedValue([]);
    txReturn.create.mockResolvedValue({ id: "ret-ok", items: [] });

    await service.create(
      { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 4 }] },
      "user-1",
    );

    expect(txReturn.findMany).toHaveBeenCalledWith({
      where: { orderId: "ord-1", status: { not: "REJECTED" } },
      include: { items: { select: { productId: true, qty: true } } },
    });
  });

  it("wraps the existingReturns read and the create inside the SAME transaction — proving no read-then-write gap survives for a concurrent create to race through", async () => {
    txReturn.findMany.mockResolvedValue([]);
    txReturn.create.mockResolvedValue({ id: "ret-1", items: [] });

    const result = await service.create(
      { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 2 }] },
      "user-1",
    );

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    // The read and the create both ran against the transaction's own `tx.return`...
    expect(txReturn.findMany).toHaveBeenCalledTimes(1);
    expect(txReturn.create).toHaveBeenCalledTimes(1);
    // ...and neither escaped to the plain, un-scoped forTenant() client, which
    // would reopen the exact read-then-write gap this fix closes.
    expect(prisma.return.findMany).not.toHaveBeenCalled();
    expect(prisma.return.create).not.toHaveBeenCalled();
    expect(result).toEqual({ id: "ret-1", items: [] });
  });

  it("allows a create that exactly consumes the remaining qty", async () => {
    txReturn.findMany.mockResolvedValue([{ items: [{ productId: "p1", qty: 6 }] }]);
    txReturn.create.mockResolvedValue({ id: "ret-2", items: [] });

    await service.create(
      { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 4 }] },
      "user-1",
    );

    expect(txReturn.create).toHaveBeenCalledTimes(1);
  });

  it("rolls the transaction back (throws) when a concurrent request already claimed the remaining qty on a fresh in-tx read", async () => {
    // Simulates the race this fix closes: by the time THIS request's transaction
    // takes its read, a concurrent request already committed a return for the
    // same product. The in-tx read must reflect that, and the create must not run.
    txReturn.findMany.mockResolvedValue([{ items: [{ productId: "p1", qty: 10 }] }]); // fully consumed

    await expect(
      service.create(
        { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 1 }] },
        "user-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("locks the order row with SELECT ... FOR UPDATE BEFORE the cumulative read, so concurrent creates serialize under READ COMMITTED", async () => {
    const callOrder: string[] = [];
    txExecuteRaw.mockImplementation(() => {
      callOrder.push("lock");
      return Promise.resolve(0);
    });
    txReturn.findMany.mockImplementation(() => {
      callOrder.push("read");
      return Promise.resolve([]);
    });
    txReturn.create.mockImplementation(() => {
      callOrder.push("create");
      return Promise.resolve({ id: "ret-3", items: [] });
    });

    await service.create(
      { orderId: "ord-1", reason: "DAMAGED", items: [{ productId: "p1", qty: 1 }] },
      "user-1",
    );

    // The transaction on its own is not a fix: at READ COMMITTED both racers
    // read a snapshot without the other's uncommitted insert and both commit.
    // The lock must be the FIRST statement, ahead of the read it protects.
    expect(callOrder).toEqual(["lock", "read", "create"]);
    const [strings, ...values] = txExecuteRaw.mock.calls[0];
    expect(strings.join("?")).toContain('"Order"');
    expect(strings.join("?")).toContain("FOR UPDATE");
    expect(values).toEqual(["ord-1"]);
  });

  it("rejects one payload that lists the same productId twice beyond the ordered qty — no concurrency required", async () => {
    txReturn.findMany.mockResolvedValue([]); // 10 ordered, nothing returned yet

    await expect(
      service.create(
        {
          orderId: "ord-1",
          reason: "DAMAGED",
          items: [
            { productId: "p1", qty: 10 },
            { productId: "p1", qty: 10 },
          ],
        },
        "user-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Before the fix both lines were checked against the same pre-request
    // snapshot (previouslyReturned = 0), so both passed and one return was
    // created for 20 units against 10 ordered — refunded in full.
    expect(txReturn.create).not.toHaveBeenCalled();
  });

  it("still allows repeated productId lines whose SUM fits the remaining qty", async () => {
    txReturn.findMany.mockResolvedValue([]);
    txReturn.create.mockResolvedValue({ id: "ret-4", items: [] });

    await service.create(
      {
        orderId: "ord-1",
        reason: "DAMAGED",
        items: [
          { productId: "p1", qty: 6 },
          { productId: "p1", qty: 4 },
        ],
      },
      "user-1",
    );

    expect(txReturn.create).toHaveBeenCalledTimes(1);
  });

  it("throws 400 (not a 500 TypeError) when the body carries no items array", async () => {
    // POST /returns binds `@Body() dto: any`, so nothing validates the shape:
    // `for (const item of dto.items)` used to throw "dto.items is not iterable"
    // from inside the transaction and surface as a 500 to any OPERATOR/DRIVER/CUSTOMER.
    await expect(
      service.create({ orderId: "ord-1", reason: "DAMAGED" }, "user-1"),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("throws 400 when items is an empty array", async () => {
    await expect(
      service.create({ orderId: "ord-1", reason: "DAMAGED", items: [] }, "user-1"),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});
