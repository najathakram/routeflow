/**
 * F-05 (#2093, owner ruling 2026-09-25): "At-door delivery of an order placed before a ban: deliver up to the
 * ordered quantity. Any increase, added line or substitution is BLOCKED, and the driver sees why."
 * `completeWithPayment` is therefore an EXEMPT row in the selling-restrictions coverage table — but only
 * because THIS check makes it true: a delivery may never exceed the ordered quantity, and may only name a
 * line of an order already on the stop. These pins are what the exemption stands on.
 */
import * as fs from "fs";
import * as ts from "typescript";
import * as path from "path";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { assertDeliveriesFitStop } from "./delivery-lines.util";

describe("assertDeliveriesFitStop — the at-door ceiling", () => {
  const stopOrders = [{ id: "o1" }];
  const tx = (items: { id: string; orderId: string; qty: number }[]) => ({
    orderItem: { findMany: jest.fn().mockResolvedValue(items) },
  });
  const item = { id: "i1", orderId: "o1", qty: 10 };

  it("allows up to the ordered quantity (what was ordered may be delivered), including short and zero", async () => {
    for (const q of [10, 7, 0]) {
      await expect(
        assertDeliveriesFitStop(tx([item]), stopOrders, [
          { orderItemId: "i1", quantityDelivered: q },
        ]),
      ).resolves.toBeUndefined();
    }
  });

  it("refuses ANY increase over the ordered quantity, and says why", async () => {
    const p = assertDeliveriesFitStop(tx([item]), stopOrders, [
      { orderItemId: "i1", quantityDelivered: 11 },
    ]);
    await expect(p).rejects.toBeInstanceOf(BadRequestException);
    await expect(p).rejects.toThrow(/between 0 and the ordered quantity/);
  });

  it("refuses an added line: an item that is not on the stop's orders", async () => {
    await expect(
      assertDeliveriesFitStop(tx([{ id: "i9", orderId: "other", qty: 5 }]), stopOrders, [
        { orderItemId: "i9", quantityDelivered: 1 },
      ]),
    ).rejects.toThrow(/does not belong to this stop/);
  });

  it("refuses a substitution: an unknown item and a duplicated line", async () => {
    await expect(
      assertDeliveriesFitStop(tx([]), stopOrders, [{ orderItemId: "ghost", quantityDelivered: 1 }]),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      assertDeliveriesFitStop(tx([item]), stopOrders, [
        { orderItemId: "i1", quantityDelivered: 1 },
        { orderItemId: "i1", quantityDelivered: 2 },
      ]),
    ).rejects.toThrow(/more than one delivery line/);
  });

  it("caps a CANCELLED line, and a line of a CANCELLED or DRAFT order still on the stop, at 0", async () => {
    const cases = [
      { ...item, status: "CANCELLED", order: { status: "CONFIRMED" } },
      { ...item, status: "PENDING", order: { status: "CANCELLED" } },
      { ...item, status: "PENDING", order: { status: "DRAFT" } },
    ];
    for (const c of cases) {
      const p = assertDeliveriesFitStop(tx([c]), stopOrders, [
        { orderItemId: "i1", quantityDelivered: 10 },
      ]);
      await expect(p).rejects.toBeInstanceOf(BadRequestException);
      // a DRAFT order's line is NOT "cancelled": it has its own wording
      await expect(p).rejects.toThrow(
        c.order.status === "DRAFT" ? /not confirmed yet/ : /was cancelled/,
      );
      // delivering nothing against it stays legal (a driver can close the stop)
      await expect(
        assertDeliveriesFitStop(tx([c]), stopOrders, [{ orderItemId: "i1", quantityDelivered: 0 }]),
      ).resolves.toBeUndefined();
    }
  });

  describe("structure: both stop-completion paths run the ceiling before any delivery write", () => {
    const src = ts.createSourceFile(
      "routes.service.ts",
      fs.readFileSync(path.join(__dirname, "routes.service.ts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const method = (name: string) => {
      let found: ts.MethodDeclaration | undefined;
      const walk = (n: ts.Node) => {
        if (ts.isMethodDeclaration(n) && n.name.getText(src) === name) found = n;
        ts.forEachChild(n, walk);
      };
      walk(src);
      return found!;
    };
    /** Start offsets of every call `x.y(...)` whose callee text ends with `suffix`, inside the method body. */
    const calls = (m: ts.MethodDeclaration, suffix: string) => {
      const at: number[] = [];
      const walk = (n: ts.Node) => {
        if (ts.isCallExpression(n) && n.expression.getText(src).endsWith(suffix))
          at.push(n.getStart(src));
        ts.forEachChild(n, walk);
      };
      walk(m.body!);
      return at.sort((a, b) => a - b);
    };

    it.each(["completeWithPayment", "completeStop"])("%s", (name) => {
      const m = method(name);
      const guard = calls(m, "assertDeliveriesFitStop");
      const writes = [...calls(m, "orderItem.update"), ...calls(m, "deliveryMutation.create")];
      expect(guard.length).toBeGreaterThan(0);
      expect(writes.length).toBeGreaterThan(0);
      expect(guard[0]).toBeLessThan(Math.min(...writes));
    });
  });
});
