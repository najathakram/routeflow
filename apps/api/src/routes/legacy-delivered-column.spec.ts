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

describe("SA-345a — deliveredQtyRecompute never erases the legacy column", () => {
  it("a line with rows recomputes to Σrows; a legacy line with none is NOT returned (its column survives)", async () => {
    const out = await deliveredQtyRecompute(rowsDb([row("a", "DELIVERED", 6)]) as any, "o1", [
      "a",
      "legacy",
    ]);
    expect(out).toEqual([{ id: "a", deliveredQty: 6 }]);
  });

  it("reopenStop: a line whose rows were just deleted recomputes to 0, a legacy sibling still untouched", async () => {
    const out = await deliveredQtyRecompute(
      rowsDb([]) as any,
      "o1",
      ["gone", "legacy"],
      [{ orderItemId: "gone" }],
    );
    expect(out).toEqual([{ id: "gone", deliveredQty: 0 }]);
  });
});
