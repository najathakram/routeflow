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
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceItem: { update: jest.fn() },
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

describe("reorderOrderLines: existing invoices follow (W-1187 PR-1e, ruling (4)/(6))", () => {
  const inv = (id: string, rows: Array<[string, string | null, number | null]>) => ({
    id,
    items: rows.map(([rid, orderItemId, position]) => ({
      id: rid,
      orderItemId,
      position,
      createdAt: AT,
      description: rid,
      productId: orderItemId,
    })),
  });
  function withInvoices(invoices: unknown[]) {
    const ctx = build({ tenantId: "t1" });
    const tx = ctx.tx as Record<string, any>;
    tx.invoice = { findMany: jest.fn().mockResolvedValue(invoices) };
    tx.invoiceItem = { update: jest.fn() };
    // the order's lines AFTER the reorder wrote them: b first, then a
    tx.order.findUnique = jest.fn().mockResolvedValue({
      lineItems: [
        { id: "b", position: 0, createdAt: AT },
        { id: "a", position: 1, createdAt: AT },
      ],
    });
    return { ...ctx, tx };
  }
  const swap = { expectedUpdatedAt: AT.toISOString(), lineIds: ["b", "a"] };

  it("R-follow: a draft/sent invoice billed [a, b] is re-ranked [b, a] in the same call, unlinked lines stay last", async () => {
    const { tx, deps } = withInvoices([
      inv("i1", [
        ["ia", "a", 0],
        ["ib", "b", 1],
        ["fee", null, 2],
      ]),
    ]);
    await reorderOrderLines(deps, "o1", swap as never, staff);
    expect(tx.invoice.findMany.mock.calls[0][0].where).toMatchObject({
      orderId: "o1",
      status: { notIn: ["VOID", "WRITTEN_OFF"] },
    });
    const wrote = Object.fromEntries(
      tx.invoiceItem.update.mock.calls.map(([a]: any) => [a.where.id, a.data.position]),
    );
    expect(wrote).toEqual({ ib: 0, ia: 1 });
  });

  it("R-legacy: an all-NULL linked invoice is stamped by the reorder, from its A-Z shown order, linked lines by the order's new ranks", async () => {
    const { tx, deps } = withInvoices([
      inv("old", [
        ["ia", "a", null],
        ["ib", "b", null],
      ]),
    ]);
    await reorderOrderLines(deps, "o1", swap as never, staff);
    const wrote = Object.fromEntries(
      tx.invoiceItem.update.mock.calls.map(([a]: any) => [a.where.id, a.data.position]),
    );
    expect(wrote).toEqual({ ib: 0, ia: 1 });
  });

  it("a pure reorder writes nothing else: no invoice updatedAt, one audit row, no revision or ledger", async () => {
    const { tx, deps } = withInvoices([
      inv("i1", [
        ["ia", "a", 0],
        ["ib", "b", 1],
      ]),
    ]);
    await reorderOrderLines(deps, "o1", swap as never, staff);
    for (const [a] of tx.invoiceItem.update.mock.calls)
      expect(Object.keys(a.data)).toEqual(["position"]);
    expect((tx as any).invoice.update).toBeUndefined();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe("order.lines.reordered");
    expect(Object.keys(tx.order.update.mock.calls[0][0].data)).toEqual(["updatedAt"]);
  });

  it("R-lock: the invoices are row-locked (NOWAIT, sorted ids) BEFORE their lines are read or written", async () => {
    const { tx, deps } = withInvoices([
      inv("i2", [
        ["ia2", "a", 0],
        ["ib2", "b", 1],
      ]),
      inv("i1", [
        ["ia", "a", 0],
        ["ib", "b", 1],
      ]),
    ]);
    const order: string[] = [];
    lock.mockImplementation(async (_t: unknown, table: string) => {
      order.push(`lock:${table}`);
    });
    tx.invoiceItem.update.mockImplementation(async () => order.push("write"));
    await reorderOrderLines(deps, "o1", swap as never, staff);
    const invoiceLock = lock.mock.calls.find((c) => c[1] === "Invoice")!;
    expect(invoiceLock[2]).toEqual(["i1", "i2"]);
    expect(invoiceLock[3]).toBe("INVOICE_BUSY");
    expect(order.indexOf("lock:Invoice")).toBeGreaterThan(order.indexOf("lock:Order"));
    expect(order.indexOf("lock:Invoice")).toBeLessThan(order.indexOf("write"));
    lock.mockReset();
    lock.mockResolvedValue(undefined);
  });

  it.each([
    ["a drag", swap, "drag"],
    ["a name sort", { expectedUpdatedAt: AT.toISOString(), sort: "name" }, "sort"],
  ])("R-via: the one audit row records whether it was %s", async (_n, body, via) => {
    const { tx, deps } = withInvoices([]);
    (tx.orderItem.findMany as jest.Mock).mockResolvedValue([
      {
        id: "a",
        position: 0,
        name: "Zed",
        productId: null,
        boxes: null,
        unitsPerBox: null,
        product: null,
      },
      {
        id: "b",
        position: 1,
        name: "Abe",
        productId: null,
        boxes: null,
        unitsPerBox: null,
        product: null,
      },
    ]);
    await reorderOrderLines(deps, "o1", body as never, staff);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create.mock.calls[0][0].data.meta.via).toBe(via);
  });

  it.each(["DRAFT", "SENT", "VIEWED", "PARTIAL", "PAID", "OVERDUE"])(
    "R-status: a %s invoice is not excluded from the follow (only VOID and WRITTEN_OFF are)",
    async (status) => {
      const { tx, deps } = withInvoices([]);
      await reorderOrderLines(deps, "o1", swap as never, staff);
      const excluded = tx.invoice.findMany.mock.calls[0][0].where.status.notIn as string[];
      expect(excluded).toEqual(["VOID", "WRITTEN_OFF"]);
      expect(excluded).not.toContain(status);
    },
  );

  it("an order whose lines did not move touches no invoice", async () => {
    const { tx, deps } = withInvoices([inv("i1", [["ia", "a", 0]])]);
    await reorderOrderLines(deps, "o1", dto, staff);
    expect(tx.invoice.findMany).not.toHaveBeenCalled();
  });
});

describe("reorderOrderLines: a name sort re-ranks the invoices too (W-1187 PR-1d + PR-1e)", () => {
  it("R-sort-follow: Zebra@0, Apple@1 sorted A-Z; the invoice billed [z, a] is re-ranked [a, z] in the same call", async () => {
    const product = (name: string) => ({
      name,
      variantName: null,
      parentProductId: null,
      parent: null,
      unitsPerBox: null,
    });
    const { tx, deps } = build({
      tenantId: "t1",
      rows: [
        {
          id: "z",
          position: 0,
          name: null,
          productId: "pz",
          boxes: null,
          unitsPerBox: null,
          product: product("Zebra Cola"),
        },
        {
          id: "a",
          position: 1,
          name: null,
          productId: "pa",
          boxes: null,
          unitsPerBox: null,
          product: product("Apple Chips"),
        },
      ],
    });
    const t = tx as Record<string, any>;
    t.invoice = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "i1",
          items: [
            {
              id: "iz",
              orderItemId: "z",
              position: 0,
              createdAt: AT,
              description: "Zebra Cola",
              productId: "pz",
            },
            {
              id: "ia",
              orderItemId: "a",
              position: 1,
              createdAt: AT,
              description: "Apple Chips",
              productId: "pa",
            },
          ],
        },
      ]),
    };
    t.invoiceItem = { update: jest.fn() };
    t.order.findUnique = jest.fn().mockResolvedValue({
      lineItems: [
        { id: "a", position: 0, createdAt: AT },
        { id: "z", position: 1, createdAt: AT },
      ],
    });
    const out = await reorderOrderLines(
      deps,
      "o1",
      { expectedUpdatedAt: AT.toISOString(), sort: "name" } as never,
      staff,
    );
    expect(out.lineIds).toEqual(["a", "z"]);
    const wrote = Object.fromEntries(
      t.invoiceItem.update.mock.calls.map(([x]: any) => [x.where.id, x.data.position]),
    );
    expect(wrote).toEqual({ ia: 0, iz: 1 });
  });
});
