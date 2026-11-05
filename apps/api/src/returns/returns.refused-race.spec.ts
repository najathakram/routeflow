/**
 * SA-1101 A-3 N1 (RO-19): returns.create reads the order's status BEFORE it takes the Order row lock. A Deliver again
 * that commits in between moves the order out of REFUSED, and a return recorded on it afterwards would be restocked on
 * goods that went out again. So create() re-reads the status after the lock and refuses with the same message.
 */
import { ReturnsService } from "./returns.service";

const GATE_MESSAGE = "Returns can only be submitted for delivered orders";
const dto = { orderId: "o1", reason: "DAMAGED", items: [{ orderItemId: "i1", quantity: 1 }] };

function serviceWhereStatusChangesUnderTheLock(afterLock: string) {
  const unlockedRead = {
    id: "o1",
    status: "REFUSED",
    customerId: "cust-1",
    lineItems: [],
    invoices: [],
  };
  const tx = {
    order: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(unlockedRead) // before the lock: still REFUSED
        .mockResolvedValue({ status: afterLock }), // after the lock: a Deliver again committed in between
    },
    customer: { findFirst: jest.fn().mockResolvedValue({ id: "cust-1" }) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    return: { create: jest.fn() },
  };
  const prisma: any = {
    getTenantId: () => "t1",
    tenantTransaction: (fn: (t: unknown) => unknown) => fn(tx),
  };
  return { tx, service: new ReturnsService(prisma, {} as any, {} as any, {} as any, {} as any) };
}

/** The order-row `FOR UPDATE` statements (B1279: the customer advisory lock is also an `$executeRaw` now). */
const orderLockCalls = (tx: { $executeRaw: jest.Mock }) =>
  tx.$executeRaw.mock.calls.filter((c) =>
    (c[0] as TemplateStringsArray).join("?").includes("FOR UPDATE"),
  );

describe("returns.create re-checks the order status after its FOR UPDATE (RO-19)", () => {
  it("RO-19: REFUSED on the first read, CONFIRMED after the lock: 400 and no Return row", async () => {
    const { tx, service } = serviceWhereStatusChangesUnderTheLock("CONFIRMED");
    await expect(service.create(dto, "u1", "OPERATOR")).rejects.toThrow(GATE_MESSAGE);
    expect(orderLockCalls(tx)).toHaveLength(1);
    expect(tx.return.create).not.toHaveBeenCalled();
  });

  it("the second read happens after the lock, not before it", async () => {
    const { tx, service } = serviceWhereStatusChangesUnderTheLock("CONFIRMED");
    await service.create(dto, "u1", "OPERATOR").catch(() => undefined);
    expect(tx.order.findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(
      tx.$executeRaw.mock.invocationCallOrder[
        tx.$executeRaw.mock.calls.indexOf(orderLockCalls(tx)[0])
      ],
    );
  });

  it("an order that is still REFUSED under the lock gets past the status gate for staff", async () => {
    const { service } = serviceWhereStatusChangesUnderTheLock("REFUSED");
    await expect(service.create(dto, "u1", "OPERATOR")).rejects.not.toThrow(GATE_MESSAGE);
  });
});
