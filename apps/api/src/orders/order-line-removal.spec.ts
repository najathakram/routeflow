import { BadRequestException, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { assertRemovalsNameALine, writeLineRemoval, writeLineUpdate } from "./order-line-removal";
import { OrdersService } from "./orders.service";

/**
 * #2563 (SA-507b): a per-line diff removal writes only a line of the order being edited —
 * `{ id, orderId }`, never a bare id — and a miss is a 404 (thrown inside the edit's tx).
 */
describe("writeLineRemoval (#2563)", () => {
  const tx = (count: number) => ({
    orderItem: {
      updateMany: jest.fn().mockResolvedValue({ count }),
      deleteMany: jest.fn().mockResolvedValue({ count }),
    },
  });

  it("a strike-off zeroes the line, scoped to this order", async () => {
    const db = tx(1);
    await writeLineRemoval(db, "ord-1", "li-1", "strike-off");
    expect(db.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: "li-1", orderId: "ord-1" },
      data: {
        status: "CANCELLED",
        qty: 0,
        subtotal: 0,
        boxes: null,
        pieces: null,
        promoFreeUnits: null,
      },
    });
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
  });

  it("a hard delete is scoped to this order", async () => {
    const db = tx(1);
    await writeLineRemoval(db, "ord-1", "li-1", "delete");
    expect(db.orderItem.deleteMany).toHaveBeenCalledWith({
      where: { id: "li-1", orderId: "ord-1" },
    });
    expect(db.orderItem.updateMany).not.toHaveBeenCalled();
  });

  it.each(["strike-off", "delete"] as const)(
    "%s of a line id NOT on this order is a 404",
    async (mode) => {
      await expect(writeLineRemoval(tx(0), "ord-1", "li-foreign", mode)).rejects.toThrow(
        NotFoundException,
      );
    },
  );

  // Lead Opus FAIL on #2573: Prisma DROPS an undefined key, so `{ id: undefined, orderId }` matched
  // EVERY line of the order — an id-less CANCEL struck them all off with count > 0 (no 404).
  it.each([undefined, null, ""])(
    "a missing line id (%p) is a 400 and writes nothing",
    async (id) => {
      for (const mode of ["strike-off", "delete"] as const) {
        const db = tx(3);
        await expect(writeLineRemoval(db, "ord-1", id as any, mode)).rejects.toThrow(
          BadRequestException,
        );
        expect(db.orderItem.updateMany).not.toHaveBeenCalled();
        expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
      }
    },
  );
});

describe("assertRemovalsNameALine (#2563 fold)", () => {
  it("refuses an id-less CANCEL or DELETE; allows named removals and non-removals", () => {
    for (const action of ["CANCEL", "DELETE"]) {
      expect(() => assertRemovalsNameALine([{ action }])).toThrow(BadRequestException);
      expect(() => assertRemovalsNameALine([{ id: "", action }])).toThrow(BadRequestException);
      expect(() => assertRemovalsNameALine([{ id: "li-1", action }])).not.toThrow();
    }
    expect(() => assertRemovalsNameALine([{ action: "UPDATE" }, {}])).not.toThrow();
    expect(() => assertRemovalsNameALine(undefined)).not.toThrow();
  });

  it.each([UserRole.OPERATOR, UserRole.DRIVER])(
    "updateOrderItems (%s): an id-less CANCEL/DELETE is a 400 before ANY read",
    async (role) => {
      for (const action of ["CANCEL", "DELETE"]) {
        const findUnique = jest.fn();
        const svc: any = Object.assign(Object.create(OrdersService.prototype), {
          prisma: {
            forTenant: () => ({ order: { findUnique }, driver: { findFirst: jest.fn() } }),
          },
        });
        await expect(
          svc.updateOrderItems(
            "ord-1",
            { replaceAll: false, items: [{ action }] },
            { role, sub: "u" },
          ),
        ).rejects.toThrow(BadRequestException);
        expect(findUnique).not.toHaveBeenCalled();
      }
    },
  );
});

describe("writeLineUpdate (#2577)", () => {
  const txWith = (update: jest.Mock) => ({ orderItem: { update } });

  it("rewrites only a line of this order: where { id, orderId }", async () => {
    const update = jest.fn().mockResolvedValue({});
    await writeLineUpdate(txWith(update), "ord-1", "li-1", { qty: 3 });
    expect(update).toHaveBeenCalledWith({
      where: { id: "li-1", orderId: "ord-1" },
      data: { qty: 3 },
    });
  });

  it("another order's line (Prisma P2025) is a 404; any other error is rethrown", async () => {
    const p2025 = Object.assign(new Error("not found"), { code: "P2025" });
    await expect(
      writeLineUpdate(txWith(jest.fn().mockRejectedValue(p2025)), "ord-1", "li-x", {}),
    ).rejects.toThrow(NotFoundException);
    const boom = new Error("db down");
    await expect(
      writeLineUpdate(txWith(jest.fn().mockRejectedValue(boom)), "ord-1", "li-x", {}),
    ).rejects.toBe(boom);
  });

  it.each([undefined, null, ""])(
    "a missing line id (%p) is a 400 and writes nothing",
    async (id) => {
      const update = jest.fn();
      await expect(writeLineUpdate(txWith(update), "ord-1", id as any, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("assertRemovalsNameALine: an id-less substitute is a 400; a named one passes", () => {
    expect(() => assertRemovalsNameALine([{ substituteProductId: "p2" }])).toThrow(
      "A substitution must name the line it replaces",
    );
    expect(() =>
      assertRemovalsNameALine([{ id: "li-1", substituteProductId: "p2" }]),
    ).not.toThrow();
  });
});
