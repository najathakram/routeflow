/**
 * SA-345/345a pins — the legacy `OrderItem.deliveredQty` column is the ONLY delivery evidence for an
 * order delivered before `DeliveryMutation` rows existed (or whose rows a pre-B803 reopen deleted).
 * ONE basis object, two readers, PER LINE:
 *  - a line WITH its own qualifying rows takes Σrows (rows beat a stale column, SA-113a);
 *  - a line with NO own row takes `deliveredQty ?? 0` — never the full qty, never 0 just because it
 *    is unseen;
 *  - coverage (`billableQtyFromBasis`, SA-093a) is unchanged: no rows ⇒ the full qty.
 * The same number drives the delivered-basis invoice rebuilds AND the stepper's remaining.
 * master's two B652 specs (invoices.service.b652.spec.ts) are the end-to-end pin for the invoice
 * side and stay UNCHANGED.
 */
import { BadRequestException } from "@nestjs/common";
import {
  billableQtyFromBasis,
  deliveredBasisByLine,
  deliveredQtyFromBasis,
} from "../invoices/delivered-basis-by-line";
import { assertDeliveriesFitStop } from "./delivery-lines.util";
import { deliveredQtyRecompute, deliveredSoFarForLine } from "./delivered-so-far";
import { attachDeliveredSoFar } from "./run-delivered-so-far";

const rowsDb = (rows: Array<Record<string, unknown>>) => ({
  deliveryMutation: { findMany: jest.fn().mockResolvedValue(rows) },
});
const row = (orderItemId: string, type: string, quantityDelivered: number | null, stop = "s1") => ({
  orderId: "o1",
  orderItemId,
  routeRunStopId: stop,
  type,
  quantityDelivered,
});

describe("SA-345a — deliveredQtyFromBasis (billing reader), per line", () => {
  it("no rows + a column of 50 against qty 60 → 50 delivered (master's rule), never the full 60", async () => {
    const basis = await deliveredBasisByLine(rowsDb([]) as any, "o1");
    expect(deliveredQtyFromBasis({ id: "li", qty: 60, deliveredQty: 50 }, basis)).toBe(50);
  });

  it("no rows + a null column → 0", async () => {
    const basis = await deliveredBasisByLine(rowsDb([]) as any, "o1");
    expect(deliveredQtyFromBasis({ id: "li", qty: 60, deliveredQty: null }, basis)).toBe(0);
    expect(deliveredQtyFromBasis({ id: "li", qty: 60 }, basis)).toBe(0);
  });

  it("rows of 10 + a stale column of 4 → 10 (the re-delivery case: rows beat the column)", async () => {
    const basis = await deliveredBasisByLine(
      rowsDb([row("li", "DELIVERED", 6, "s1"), row("li", "PARTIAL", 4, "s2")]) as any,
      "o1",
    );
    expect(deliveredQtyFromBasis({ id: "li", qty: 20, deliveredQty: 4 }, basis)).toBe(10);
  });

  it("a REFUSED row + a stale column of 30 → 0 (the row decides, the column does not resurrect it)", async () => {
    const basis = await deliveredBasisByLine(rowsDb([row("li", "REFUSED", 0)]) as any, "o1");
    expect(deliveredQtyFromBasis({ id: "li", qty: 60, deliveredQty: 30 }, basis)).toBe(0);
  });

  it("a mixed order: one line with rows, one with only the column — each by its own rule", async () => {
    const basis = await deliveredBasisByLine(rowsDb([row("a", "DELIVERED", 6)]) as any, "o1");
    expect(deliveredQtyFromBasis({ id: "a", qty: 10, deliveredQty: 0 }, basis)).toBe(6);
    expect(deliveredQtyFromBasis({ id: "b", qty: 10, deliveredQty: 5 }, basis)).toBe(5);
    expect(deliveredQtyFromBasis({ id: "c", qty: 10, deliveredQty: null }, basis)).toBe(0);
  });

  it("a stale column above qty is capped at qty (never bills units nobody ordered)", async () => {
    const basis = await deliveredBasisByLine(rowsDb([]) as any, "o1");
    expect(deliveredQtyFromBasis({ id: "li", qty: 60, deliveredQty: 90 }, basis)).toBe(60);
  });
});

describe("SA-345a — coverage is UNCHANGED (billableQtyFromBasis, SA-093a)", () => {
  it("no rows at all → the full qty, even with a column of 50", async () => {
    const basis = await deliveredBasisByLine(rowsDb([]) as any, "o1");
    expect(billableQtyFromBasis({ id: "li", qty: 60 }, basis)).toBe(60);
  });

  it("a line with no row of its own on an order that HAS rows elsewhere → still the full qty", async () => {
    const basis = await deliveredBasisByLine(rowsDb([row("a", "DELIVERED", 6)]) as any, "o1");
    expect(billableQtyFromBasis({ id: "b", qty: 10 }, basis)).toBe(10);
    expect(billableQtyFromBasis({ id: "a", qty: 10 }, basis)).toBe(6);
  });
});

describe("SA-345a — deliveredSoFarForLine (the stepper's remaining reads the SAME number)", () => {
  it("no row + column 50 vs qty 60 → delivered-so-far 50, remaining 10", () => {
    const soFar = deliveredSoFarForLine(undefined, "s9", 50);
    expect(soFar).toBe(50);
    expect(60 - soFar).toBe(10);
  });

  it("no row + null column → 0, remaining 60", () => {
    const soFar = deliveredSoFarForLine([], "s9", null);
    expect(soFar).toBe(0);
    expect(60 - soFar).toBe(60);
  });

  it("rows of 10 + a stale column of 4 → 10 (rows beat the column)", () => {
    const rows = [
      {
        orderId: "o1",
        orderItemId: "li",
        routeRunStopId: "s1",
        type: "DELIVERED",
        quantityDelivered: 10,
      },
    ];
    expect(deliveredSoFarForLine(rows, "s9", 4)).toBe(10);
  });

  it("a stale column above qty is capped at qty (remaining is 0, never negative) — one number with billing", () => {
    const soFar = deliveredSoFarForLine(undefined, "s9", 90, 60);
    expect(soFar).toBe(60);
    expect(60 - soFar).toBe(0);
    // no qty supplied ⇒ uncapped (the projection/fit-check always supply it)
    expect(deliveredSoFarForLine(undefined, "s9", 90)).toBe(90);
  });

  it("rows only at the stop being read are excluded and read 0 — NOT the column those rows produced", () => {
    const rows = [
      {
        orderId: "o1",
        orderItemId: "li",
        routeRunStopId: "s9",
        type: "DELIVERED",
        quantityDelivered: 40,
      },
    ];
    expect(deliveredSoFarForLine(rows, "s9", 40)).toBe(0);
  });
});

describe("SA-345a — the projection and the fit-check use the same reader", () => {
  it("attachDeliveredSoFar: a legacy line (no row) projects deliveredSoFar = its column", () => {
    const stops = [
      {
        id: "s2",
        orders: [{ id: "o1", lineItems: [{ id: "legacy", deliveredQty: 50 }, { id: "fresh" }] }],
      },
    ];
    const out = attachDeliveredSoFar(stops as any, {
      o1: { fresh: [row("fresh", "DELIVERED", 3, "s1")] as any },
    });
    const lines = out[0]!.orders[0]!.lineItems as any[];
    expect(lines.find((l) => l.id === "legacy")!.deliveredSoFar).toBe(50);
    expect(lines.find((l) => l.id === "fresh")!.deliveredSoFar).toBe(3);
  });

  it("attachDeliveredSoFar: a legacy column above qty projects qty (the stepper's remaining is 0, not negative)", () => {
    const stops = [
      { id: "s2", orders: [{ id: "o1", lineItems: [{ id: "x", qty: 60, deliveredQty: 90 }] }] },
    ];
    const out = attachDeliveredSoFar(stops as any, {});
    expect((out[0]!.orders[0]!.lineItems as any[])[0].deliveredSoFar).toBe(60);
  });

  it("assertDeliveriesFitStop: a legacy line (qty 60, column 50, no rows) has 10 left — 10 fits, 11 is refused", async () => {
    const tx = {
      orderItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "li", orderId: "o1", qty: 60, deliveredQty: 50, name: "Widget", product: null },
          ]),
      },
      deliveryMutation: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const call = (q: number) =>
      assertDeliveriesFitStop(
        tx,
        "s2",
        [{ id: "o1" }],
        [{ orderItemId: "li", quantityDelivered: q }],
      );

    await expect(call(10)).resolves.toBeUndefined();
    await expect(call(11)).rejects.toThrow(BadRequestException);
    await expect(call(11)).rejects.toThrow("Widget: 10 left, 50 delivered earlier");
  });
});

describe("SA-346 — deliveredQtyRecompute: rows decide, the force set is the rows ACTUALLY deleted", () => {
  // The helper reads deliveryMutation (basis) and orderItem (qty cap) from the SAME tx.
  const dbWith = (rows: Array<Record<string, unknown>>, qtyById: Record<string, number> = {}) => ({
    deliveryMutation: { findMany: jest.fn().mockResolvedValue(rows) },
    orderItem: {
      findMany: jest
        .fn()
        .mockResolvedValue(Object.entries(qtyById).map(([id, qty]) => ({ id, qty }))),
    },
  });
  const deleted = (orderItemId: string | null, type = "DELIVERED", quantityDelivered = 6) => ({
    orderId: "o1",
    orderItemId,
    type,
    quantityDelivered,
  });

  it("(1) sibling visit: legacy line A (column 50, no rows) stays untouched; line B, closed today with a row, = its row", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([row("B", "DELIVERED", 4)], { B: 10 }) as any,
      "o1",
      ["A", "B"],
    );
    expect(out).toEqual([{ id: "B", deliveredQty: 4 }]);
  });

  it("(2a) reopen of S: a line with rows ONLY at S recomputes to 0", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([], { X: 10 }) as any,
      "o1",
      ["X"],
      [deleted("X")],
    );
    expect(out).toEqual([{ id: "X", deliveredQty: 0 }]);
  });

  it("(2b) reopen of S: a line with rows at S AND T recomputes to Σ of T (S's rows are already deleted)", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([row("Y", "DELIVERED", 3, "T")], { Y: 10 }) as any,
      "o1",
      ["Y"],
      [deleted("Y", "DELIVERED", 6)],
    );
    expect(out).toEqual([{ id: "Y", deliveredQty: 3 }]);
  });

  it("(2c) reopen of S: a legacy line on the same order with NO row at S keeps its column (not in the force set)", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([], { X: 10, L: 10 }) as any,
      "o1",
      ["X", "L"],
      [deleted("X")],
    );
    expect(out).toEqual([{ id: "X", deliveredQty: 0 }]); // L is not returned ⇒ never rewritten
  });

  it("(2d-i) a deleted row with a NON-EVIDENCE TYPE (ADD_ON, even with a qty) forces nothing — change-request provenance never fed the column", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([], { L: 10 }) as any,
      "o1",
      ["L"],
      [deleted("L", "ADD_ON", 5)],
    );
    expect(out).toEqual([]);
  });

  it("(2d-ii) a deleted EVIDENCE-TYPED row with a NULL quantityDelivered (REFUSED, qty null) forces nothing — it never qualified", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([], { L: 10 }) as any,
      "o1",
      ["L"],
      [deleted("L", "REFUSED", null as any)],
    );
    expect(out).toEqual([]);
  });

  it("(3) a replayed close (same rows) gives the same numbers", async () => {
    const db = dbWith([row("A", "DELIVERED", 6), row("A", "PARTIAL", 2, "s2")], { A: 20 });
    const first = await deliveredQtyRecompute(db as any, "o1", ["A"]);
    const second = await deliveredQtyRecompute(db as any, "o1", ["A"]);
    expect(first).toEqual([{ id: "A", deliveredQty: 8 }]);
    expect(second).toEqual(first);
  });

  it("(4) rows summing above qty are capped at qty", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([row("A", "DELIVERED", 8), row("A", "DELIVERED", 7, "s2")], { A: 10 }) as any,
      "o1",
      ["A"],
    );
    expect(out).toEqual([{ id: "A", deliveredQty: 10 }]);
  });

  it("a REFUSED row recomputes to 0 (a line WITH a row, so the row decides)", async () => {
    const out = await deliveredQtyRecompute(
      dbWith([row("A", "REFUSED", 0)], { A: 10 }) as any,
      "o1",
      ["A"],
    );
    expect(out).toEqual([{ id: "A", deliveredQty: 0 }]);
  });
});
