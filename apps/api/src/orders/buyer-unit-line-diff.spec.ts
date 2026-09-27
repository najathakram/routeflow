import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { assertOrderEditAllowed, buyerLineDiffVerdict } from "./unit-aware-guard";
import { assertBuyerDiffShape, classifyEditPayload } from "./order-edit-payload";
import { orderEditMode } from "./order-edit-restrictions";
import { assertBuyerOwnsOrder, prepareUnitEditContext } from "./unit-line-edit";
import { sellableLinesForMergeEdit } from "../selling-restrictions/order-edit-lines";

/**
 * SA-407 (#2272) — a CUSTOMER may edit a unit line ONLY through the per-line diff: count up, count
 * down, remove. A unit switch, boxes/pieces on a unit line, or a new buyer unit line is a 409
 * UNIT_AWARE_LINE; every other buyer diff keeps its 400; replace-all with a unit line keeps its 409.
 * The restriction netting counts an id-matched unit line at its HELD snapshot factor.
 * (Real-Postgres pins for the same ruling: buyer-unit-line-diff.db.spec.ts, run by F2.)
 */

// A 3-Case line on a 12-pack: qty is stored in pieces (36), boxes = the count (3), the snapshot
// factor rides on the line's own unitsPerBox.
const caseLine = {
  id: "li-case",
  productId: "p-cola",
  unitLabel: "Case",
  unitsPerBox: 12,
  qty: 36,
  boxes: 3,
  pieces: 0,
  status: "PENDING",
};
const packLine = {
  id: "li-pack",
  productId: "p-chips",
  unitLabel: null,
  unitsPerBox: 6,
  qty: 6,
  boxes: 1,
  pieces: 0,
  status: "PENDING",
};
const lines = [caseLine, packLine];
const diff = (...items: any[]) => ({ replaceAll: false, items });
const buyer = { role: UserRole.CUSTOMER, sub: "user-buyer" };
const owner = async () => ({ id: "cust-1" });
const order = { customerId: "cust-1", lineItems: lines };

describe("buyerLineDiffVerdict (SA-407)", () => {
  it("allows a count up, a count down, and a removal", () => {
    expect(buyerLineDiffVerdict(lines, diff({ id: "li-case", unitLabel: "Case", qty: 4 }))).toBe(
      "ok",
    );
    expect(
      buyerLineDiffVerdict(
        lines,
        diff({ id: "li-case", unitLabel: "Case", qty: 2, productId: "p-cola" }),
      ),
    ).toBe("ok");
    expect(buyerLineDiffVerdict(lines, diff({ id: "li-case", action: "CANCEL" }))).toBe("ok");
  });

  it("refuses a unit switch, boxes/pieces on a unit line, and a new unit line", () => {
    for (const d of [
      diff({ id: "li-case", unitLabel: "Pallet", qty: 1 }),
      diff({ id: "li-case", unitLabel: "Case", qty: 4, boxes: 4 }),
      diff({ id: "li-case", unitLabel: "Case", pieces: 3 }),
      diff({ productId: "p-cola", unitLabel: "Case", qty: 2 }),
    ]) {
      expect(typeof buyerLineDiffVerdict(lines, d)).toBe("object");
    }
  });

  it("any other buyer diff is not this shape (prices, pack lines, substitutes, replace-all)", () => {
    for (const d of [
      diff({ id: "li-case", unitLabel: "Case", qty: 4, unitPrice: 1 }),
      diff({ id: "li-case", unitLabel: "Case", qty: 4, substituteProductId: "p-x" }),
      diff({ id: "li-case", unitLabel: "Case", qty: 4, productId: "p-other" }),
      diff({ id: "li-pack", qty: 2 }),
      diff({ productId: "p-chips", qty: 2 }),
      { replaceAll: true, items: [{ id: "li-case", unitLabel: "Case", qty: 4 }] },
    ]) {
      expect(buyerLineDiffVerdict(lines, d)).toBe("shape");
    }
  });
});

describe("assertOrderEditAllowed — CUSTOMER on a unit-line order (SA-407)", () => {
  it("lets the count diff through after the ownership check", async () => {
    await expect(
      assertOrderEditAllowed(
        order,
        diff({ id: "li-case", unitLabel: "Case", qty: 4 }),
        buyer,
        owner,
      ),
    ).resolves.toBeUndefined();
  });

  it("409s a unit switch, and a non-owner meets the bare 403 first", async () => {
    const d = diff({ id: "li-case", unitLabel: "Pallet", qty: 1 });
    await expect(assertOrderEditAllowed(order, d, buyer, owner)).rejects.toMatchObject({
      response: { code: "UNIT_AWARE_LINE" },
    });
    await expect(
      assertOrderEditAllowed(order, d, buyer, async () => ({ id: "someone-else" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("409s a new buyer unit line even on an order that holds none", async () => {
    await expect(
      assertOrderEditAllowed(
        { customerId: "cust-1", lineItems: [packLine] },
        diff({ productId: "p-cola", unitLabel: "Case", qty: 2 }),
        buyer,
        owner,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("replace-all with a unit line stays a 409, unchanged", async () => {
    await expect(
      assertOrderEditAllowed(
        order,
        { replaceAll: true, items: [{ productId: "p-cola", qty: 48 } as any] },
        buyer,
        owner,
      ),
    ).rejects.toMatchObject({ response: { code: "UNIT_AWARE_LINE" } });
  });
});

describe("classifyEditPayload — CUSTOMER (SA-407)", () => {
  it("never throws for a buyer: it only classifies (the 400 moved behind the guard, SA-507a)", () => {
    for (const d of [
      diff({ id: "li-case", unitLabel: "Case", qty: 4 }),
      diff({ id: "li-pack", action: "DELETE" }),
      diff({ id: "li-pack", qty: 2 }),
      diff({ id: "li-case", unitLabel: "Each", qty: 4 }),
    ]) {
      expect(classifyEditPayload(order, d as any, buyer)).toBe(true);
    }
  });
});

describe("assertBuyerDiffShape — the buyer-diff 400 (SA-507b)", () => {
  const check = (d: any, findOwner = owner) =>
    assertBuyerDiffShape(order, d, buyer, true, findOwner);

  it("passes the count diff and a removal of this order's own line", async () => {
    await expect(
      check(diff({ id: "li-case", unitLabel: "Case", qty: 4 })),
    ).resolves.toBeUndefined();
    await expect(check(diff({ id: "li-pack", action: "DELETE" }))).resolves.toBeUndefined();
  });

  it("keeps the 400 for every other buyer diff", async () => {
    for (const d of [diff({ id: "li-pack", qty: 2 }), diff({ productId: "p-chips", qty: 2 })]) {
      await expect(check(d)).rejects.toThrow(BadRequestException);
    }
  });

  it("a CANCEL/DELETE naming ANOTHER order's line is the 400 'shape', never admitted", async () => {
    for (const action of ["CANCEL", "DELETE"]) {
      expect(buyerLineDiffVerdict(lines, diff({ id: "li-foreign", action }))).toBe("shape");
      await expect(check(diff({ id: "li-foreign", action }))).rejects.toThrow(BadRequestException);
    }
  });

  it("a non-owner meets the bare 403, never the 400", async () => {
    await expect(
      check(diff({ id: "li-foreign", action: "CANCEL" }), async () => ({ id: "cust-other" })),
    ).rejects.toThrow(ForbiddenException);
  });

  it("never answers a 409 shape itself (the guard does), and ignores staff/full lists", async () => {
    await expect(
      check(diff({ id: "li-case", unitLabel: "Each", qty: 4 })),
    ).resolves.toBeUndefined();
    await expect(
      assertBuyerDiffShape(
        order,
        diff({ id: "li-pack", qty: 2 }) as any,
        { role: "OPERATOR" },
        true,
        owner,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertBuyerDiffShape(
        order,
        { items: [{ productId: "p-chips", qty: 2 }] } as any,
        buyer,
        false,
        owner,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("orderEditMode — a buyer diff merges (SA-407)", () => {
  it("diff → merge; full list → replace as before", () => {
    expect(orderEditMode(UserRole.CUSTOMER, false, true)).toEqual({ kind: "merge" });
    expect(orderEditMode(UserRole.CUSTOMER, undefined, false)).toEqual({
      kind: "replace",
      actor: "buyer",
    });
  });
});

describe("restriction netting of a unit line at its HELD factor (SA-377 → SA-407)", () => {
  const live = new Map([["p-cola", 24]]); // repacked 12 → 24 since the order
  const net = (qty: number, unitLabel = "Case") =>
    sellableLinesForMergeEdit([caseLine], [{ id: "li-case", unitLabel, qty }], {
      liveUnitsPerBox: live,
    });

  it("3 → 4 Cases on a 12-pack is +12 pieces (checked as an increase)", () => {
    expect(net(4)).toEqual([{ productId: "p-cola", qtyDelta: 12 }]);
  });

  it("3 → 2 Cases is −12 pieces (a decrease passes)", () => {
    expect(net(2)).toEqual([{ productId: "p-cola", qtyDelta: -12 }]);
  });

  it("an unchanged re-send after a repack nets 0 (the held factor, never the live pack)", () => {
    expect(net(3)).toEqual([{ productId: "p-cola", qtyDelta: 0 }]);
  });

  it("a different unit re-denominates the line: sized unknown, so checked (fail closed)", () => {
    expect(net(1, "Pallet")).toEqual([{ productId: "p-cola" }]);
  });
});

describe("prepareUnitEditContext — a buyer keeping its line's own unit is not 'choosing' one", () => {
  const self = (hasFlag: boolean) =>
    ({
      prisma: {
        getTenantId: () => "t1",
        forTenant: () => ({
          product: { findMany: jest.fn().mockResolvedValue([]) },
          productUnit: { findMany: jest.fn().mockResolvedValue([]) },
        }),
      },
      entitlements: { hasFlag: jest.fn().mockResolvedValue(hasFlag) },
    }) as any;

  it("a count edit at the stored unit passes the staff-only gate", async () => {
    await expect(
      prepareUnitEditContext(
        self(false),
        order,
        diff({ id: "li-case", unitLabel: "Case", qty: 4 }) as any,
        buyer,
      ),
    ).resolves.toBeDefined();
  });

  it("a buyer naming a unit a line does not hold is still refused", async () => {
    await expect(
      prepareUnitEditContext(
        self(false),
        order,
        diff({ id: "li-pack", unitLabel: "Case", qty: 1 }) as any,
        buyer,
      ),
    ).rejects.toThrow("Only staff can choose a selling unit");
  });
});

describe("assertBuyerOwnsOrder — the merge branch re-checks buyer ownership in the tx", () => {
  const tx = (row: { id: string } | null) => ({
    customer: { findFirst: jest.fn().mockResolvedValue(row) },
  });

  it("403s a non-owner (or a removed customer) and passes the owner", async () => {
    await expect(assertBuyerOwnsOrder(tx(null), buyer, "cust-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      assertBuyerOwnsOrder(tx({ id: "cust-2" }), buyer, "cust-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(assertBuyerOwnsOrder(tx({ id: "cust-1" }), buyer, "cust-1")).resolves.toBe(
      undefined,
    );
  });

  it("is a no-op for staff", async () => {
    const t = tx(null);
    await assertBuyerOwnsOrder(t, { role: UserRole.OPERATOR }, "cust-1");
    expect(t.customer.findFirst).not.toHaveBeenCalled();
  });
});
