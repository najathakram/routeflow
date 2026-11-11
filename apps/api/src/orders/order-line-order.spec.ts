import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { lockRowsNoWait } from "../common/db-locks";
import { reorderOrderLines } from "./order-line-order";
import { orderLineInvoiceDescription } from "../invoices/invoice-line-name";
import { sortInvoiceLines } from "../invoices/invoice-line-order";

jest.mock("../common/db-locks", () => ({ lockRowsNoWait: jest.fn().mockResolvedValue(undefined) }));

/**
 * W-1187 PR-1b: the two orderings that keep `reorderOrderLines` from failing open or from answering the wrong status.
 *   - a null tenant is refused BEFORE any read (the scoped `where` would otherwise be `{}` and match any order by id);
 *   - a buyer's ownership check runs BEFORE the row lock: a same-tenant non-owner gets 403 (never the lock's 409) and
 *     never holds the Order row for the check.
 */
const AT = new Date("2026-11-01T12:00:00.000Z");

function build(opts: {
  rows?: Array<Record<string, unknown>>;
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
      findMany: jest.fn().mockResolvedValue(
        opts.rows ?? [
          { id: "a", position: 0 },
          { id: "b", position: 1 },
        ],
      ),
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

describe("reorderOrderLines: sort name (W-1187 ruling 7)", () => {
  const row = (
    id: string,
    position: number,
    name: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    position,
    name: null,
    productId: `p-${id}`,
    boxes: null,
    unitsPerBox: null,
    product: { name, variantName: null, parentProductId: null, parent: null },
    ...extra,
  });
  const sortDto = { expectedUpdatedAt: AT.toISOString(), sort: "name" as const };

  it("R-sort: lines Zebra@0, Apple@1 come out Apple, Zebra, with both positions written", async () => {
    const { tx, deps } = build({
      tenantId: "t1",
      rows: [row("z", 0, "Zebra Cola"), row("a", 1, "Apple Chips")],
    });
    const out = await reorderOrderLines(deps, "o1", sortDto as never, staff);
    expect(out.lineIds).toEqual(["a", "z"]);
    expect(tx.orderItem.update).toHaveBeenCalledWith({ where: { id: "a" }, data: { position: 0 } });
    expect(tx.orderItem.update).toHaveBeenCalledWith({ where: { id: "z" }, data: { position: 1 } });
  });

  it("G-h: it is the A to Z order the invoice copy would print, for every shuffle (family names, custom lines)", async () => {
    const lines = [
      row("v1", 0, "Classic", {
        product: {
          name: "Classic",
          variantName: "Classic",
          parentProductId: "f",
          parent: { name: "Cola" },
          unitsPerBox: null,
        },
      }),
      row("c", 1, "", { productId: null, product: null, name: "Delivery charge" }),
      row("b", 2, "Brand B"),
      row("a12", 3, "brand a 12oz"),
      row("a8", 4, "BRAND A 8OZ"),
    ];
    const printed = lines.map((l) => ({
      id: l.id as string,
      description: orderLineInvoiceDescription(l as never),
      productId: l.productId as string | null,
    }));
    const expected = sortInvoiceLines(printed).map((l) => l.id);
    for (const rows of [lines, [...lines].reverse(), [...lines.slice(2), ...lines.slice(0, 2)]]) {
      const { deps } = build({ tenantId: "t1", rows });
      const out = await reorderOrderLines(deps, "o1", sortDto as never, staff);
      expect(out.lineIds).toEqual(expected);
    }
  });

  it("a buyer may sort too (same service), and an already sorted order writes nothing", async () => {
    const { tx, deps } = build({
      tenantId: "t1",
      ownerId: "c1",
      rows: [row("a", 0, "Apple"), row("z", 1, "Zebra")],
    });
    const out = await reorderOrderLines(deps, "o1", sortDto as never, buyer);
    expect(out.lineIds).toEqual(["a", "z"]);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
  });
});
