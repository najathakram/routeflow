import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { lockRowsNoWait } from "../common/db-locks";
import { reorderOrderLines } from "./order-line-order";

jest.mock("../common/db-locks", () => ({ lockRowsNoWait: jest.fn().mockResolvedValue(undefined) }));

/**
 * W-1187 PR-1b: the two orderings that keep `reorderOrderLines` from failing open or from answering the wrong status.
 *   - a null tenant is refused BEFORE any read (the scoped `where` would otherwise be `{}` and match any order by id);
 *   - a buyer's ownership check runs BEFORE the row lock: a same-tenant non-owner gets 403 (never the lock's 409) and
 *     never holds the Order row for the check.
 */
const AT = new Date("2026-11-01T12:00:00.000Z");

function build(opts: {
  tenantId: string | null;
  ownerId?: string | null;
  orderCustomerId?: string;
}) {
  const tx = {
    order: {
      findFirst: jest.fn().mockResolvedValue({
        id: "o1",
        tenantId: "t1",
        customerId: opts.orderCustomerId ?? "c1",
        status: "PENDING",
        updatedAt: AT,
      }),
      update: jest.fn(),
    },
    customer: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.ownerId === null ? null : { id: opts.ownerId ?? "c1" }),
    },
    orderItem: {
      findMany: jest.fn().mockResolvedValue([
        { id: "a", position: 0 },
        { id: "b", position: 1 },
      ]),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn(), findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    getTenantId: jest.fn().mockReturnValue(opts.tenantId),
    tenantTransaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const deps = { prisma, closedMessage: jest.fn() } as never;
  return { tx, prisma, deps };
}

const staff = {
  sub: "u-staff",
  role: UserRole.TENANT_ADMIN,
  tenantId: "t1",
} as unknown as JwtPayload;
const buyer = { sub: "u-buyer", role: UserRole.CUSTOMER, tenantId: "t1" } as unknown as JwtPayload;
const dto = { expectedUpdatedAt: AT.toISOString(), lineIds: ["a", "b"] };
const lock = lockRowsNoWait as jest.Mock;

beforeEach(() => lock.mockClear());

describe("reorderOrderLines: a null tenant fails closed", () => {
  it.each([
    ["staff", staff],
    ["buyer", buyer],
  ])("refuses a %s caller with no tenant before any read, lock or write", async (_n, user) => {
    const { tx, prisma, deps } = build({ tenantId: null });
    await expect(reorderOrderLines(deps, "o1", dto, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(tx.order.findFirst).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it("scopes every order read to the tenant when there is one", async () => {
    const { tx, deps } = build({ tenantId: "t1" });
    await reorderOrderLines(deps, "o1", dto, staff);
    for (const [arg] of tx.order.findFirst.mock.calls) {
      expect(arg.where).toEqual({ id: "o1", tenantId: "t1" });
    }
  });
});

describe("reorderOrderLines: the buyer ownership check runs before the row lock", () => {
  it("a same-tenant buyer who does not own the order gets 403 and the lock is never taken", async () => {
    const { tx, deps } = build({ tenantId: "t1", ownerId: "c-other" });
    await expect(reorderOrderLines(deps, "o1", dto, buyer)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(lock).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it("a buyer with no customer record gets 403 and the lock is never taken", async () => {
    const { deps } = build({ tenantId: "t1", ownerId: null });
    await expect(reorderOrderLines(deps, "o1", dto, buyer)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(lock).not.toHaveBeenCalled();
  });

  it("the owner passes the check and then takes the lock once", async () => {
    const { deps } = build({ tenantId: "t1", ownerId: "c1" });
    const out = await reorderOrderLines(deps, "o1", dto, buyer);
    expect(out.lineIds).toEqual(["a", "b"]);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it("staff is not asked for ownership: no customer lookup, one lock", async () => {
    const { tx, deps } = build({ tenantId: "t1" });
    await reorderOrderLines(deps, "o1", dto, staff);
    expect(tx.customer.findFirst).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledTimes(1);
  });
});
