/**
 * Returns action-flag gating must mirror the server's transition guards exactly,
 * so the mobile UI never offers a transition the server would 400.
 */
import {
  buildReturnItems,
  restockForReason,
  returnActionFlags,
  returnPillFor,
  summarizeSubmissions,
  toUndeliveredStop,
  undeliveredReturnLines,
  undeliveredRowKey,
} from "../lib/returns-logic";

describe("returnActionFlags", () => {
  it("PENDING → approve + reject only", () => {
    const f = returnActionFlags("PENDING");
    expect(f).toMatchObject({
      canApprove: true,
      canReject: true,
      canMarkInTransit: false,
      canReceive: false,
      canResolveWithoutReceipt: false,
      canRefund: false,
      terminal: false,
    });
  });

  it("APPROVED → in-transit, receive, and resolve-without-receiving", () => {
    const f = returnActionFlags("APPROVED");
    expect(f.canMarkInTransit).toBe(true);
    expect(f.canReceive).toBe(true);
    expect(f.canResolveWithoutReceipt).toBe(true);
    expect(f.canApprove).toBe(false);
  });

  it("IN_TRANSIT → receive and resolve-without-receiving", () => {
    const f = returnActionFlags("IN_TRANSIT");
    expect(f.canReceive).toBe(true);
    expect(f.canResolveWithoutReceipt).toBe(true);
    expect(f.canMarkInTransit).toBe(false);
  });

  it("RECEIVED → refund only", () => {
    const f = returnActionFlags("RECEIVED");
    expect(f.canRefund).toBe(true);
    expect(f.canReceive).toBe(false);
    expect(f.canResolveWithoutReceipt).toBe(false);
  });

  it("terminal statuses offer nothing", () => {
    for (const s of ["REFUNDED", "PROCESSED", "REJECTED", "CANCELLED"] as const) {
      const f = returnActionFlags(s);
      expect(f.terminal).toBe(true);
      expect(
        f.canApprove ||
          f.canReject ||
          f.canMarkInTransit ||
          f.canReceive ||
          f.canResolveWithoutReceipt ||
          f.canRefund,
      ).toBe(false);
    }
  });
});

describe("returnActionFlags.canCancel (T11, REG-B21)", () => {
  const flagsFor = (status: string) => returnActionFlags(status);

  it("PENDING and RECEIVED can be cancelled", () => {
    expect(flagsFor("PENDING").canCancel).toBe(true);
    expect(flagsFor("RECEIVED").canCancel).toBe(true);
  });

  it("REFUNDED, CANCELLED, and REJECTED cannot be cancelled", () => {
    expect(flagsFor("REFUNDED").canCancel).toBe(false);
    expect(flagsFor("CANCELLED").canCancel).toBe(false);
    expect(flagsFor("REJECTED").canCancel).toBe(false);
  });
});

describe("restockForReason (T7, REG-B61)", () => {
  it("DAMAGED does not restock", () => {
    expect(restockForReason("DAMAGED")).toBe(false);
  });

  it("CUSTOMER_REFUSED restocks", () => {
    expect(restockForReason("CUSTOMER_REFUSED")).toBe(true);
  });
});

describe("buildReturnItems", () => {
  const lines = [
    { productId: "a", orderedQty: 10 },
    { productId: "b", orderedQty: 4 },
    { productId: null, orderedQty: 3 }, // unlisted — always skipped
  ];

  it("skips blank/zero/unlisted lines and keeps entered ones", () => {
    const out = buildReturnItems(lines, { a: "3" }, {}, "CUSTOMER_REFUSED");
    expect(out).toEqual([{ productId: "a", qty: 3, restock: true }]);
  });

  it("caps the return qty at the ordered qty", () => {
    const out = buildReturnItems(lines, { b: "99" }, {}, "CUSTOMER_REFUSED");
    expect(out).toEqual([{ productId: "b", qty: 4, restock: true }]);
  });

  it("REG-B61 restock default comes from the return reason, not a hardcoded true", () => {
    // No explicit override for either line: "a" and "b" must both default via
    // restockForReason("DAMAGED") === false, not the old hardcoded `true`.
    const out = buildReturnItems(lines, { a: "1", b: "2" }, {}, "DAMAGED");
    expect(out).toEqual([
      { productId: "a", qty: 1, restock: false },
      { productId: "b", qty: 2, restock: false },
    ]);
  });

  it("REG-B61 an explicit per-line restock choice still overrides the reason default", () => {
    const out = buildReturnItems(lines, { a: "1", b: "2" }, { a: true }, "DAMAGED");
    expect(out).toEqual([
      { productId: "a", qty: 1, restock: true }, // explicit override wins
      { productId: "b", qty: 2, restock: false }, // falls back to the DAMAGED default
    ]);
  });

  it("ignores non-numeric / negative qty", () => {
    expect(buildReturnItems(lines, { a: "abc", b: "-2" }, {}, "CUSTOMER_REFUSED")).toEqual([]);
  });
});

describe("undeliveredReturnLines (T10, REG-B128)", () => {
  // stop with one order carrying 4 lines: a PARTIAL (li1), a REFUSED (li2), a
  // fully DELIVERED line (li3, must be skipped entirely), and a PARTIAL that
  // happens to have delivered the full ordered qty (li4 — must yield qty 0
  // and be dropped, never emitted as a zero-qty row/payload item).
  const stop = {
    id: "stop-1",
    orders: [
      {
        id: "ord-1",
        lineItems: [
          { id: "li1", productId: "p1", qty: 10, unitPrice: 15, subtotal: 100 },
          { id: "li2", productId: "p2", qty: 5, unitPrice: 10, subtotal: 50 },
          { id: "li3", productId: "p3", qty: 2, unitPrice: 20, subtotal: 40 },
          { id: "li4", productId: "p4", qty: 3, unitPrice: 10, subtotal: 30 },
        ],
      },
    ],
    deliveryMutations: [
      { id: "m1", orderItemId: "li1", productId: "p1", type: "PARTIAL", quantityDelivered: 6 },
      { id: "m2", orderItemId: "li2", productId: "p2", type: "REFUSED", quantityDelivered: 0 },
      { id: "m3", orderItemId: "li3", productId: "p3", type: "DELIVERED", quantityDelivered: 2 },
      { id: "m4", orderItemId: "li4", productId: "p4", type: "PARTIAL", quantityDelivered: 3 },
    ],
  } as any;

  it("rows carry the box-safe undelivered amount, keyed on undelivered qty not quantityDelivered", () => {
    const result = undeliveredReturnLines(stop);
    expect(result.rows.map((r: any) => r.productId)).toEqual(["p1", "p2"]);
    // qty is the UNDELIVERED remainder (10 − 6, 5 − 0), never quantityDelivered.
    expect(result.rows.map((r: any) => r.qty)).toEqual([4, 5]);
    expect(result.rows.map((r: any) => r.amount)).toEqual([40, 50]);
  });

  it("DELIVERED lines are skipped and a fully-delivered PARTIAL yields no zero-qty row", () => {
    const result = undeliveredReturnLines(stop);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.some((r: any) => r.productId === "p3")).toBe(false);
    expect(result.rows.some((r: any) => r.productId === "p4")).toBe(false);
  });

  it("total sums the row amounts", () => {
    const result = undeliveredReturnLines(stop);
    expect(result.total).toBe(90);
  });

  it("payload is grouped by orderId with one return per order and no zero-qty items", () => {
    const result = undeliveredReturnLines(stop);
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0].orderId).toBe("ord-1");
    expect(result.payloads[0].items.map((i: any) => i.productId)).toEqual(["p1", "p2"]);
    expect(result.payloads[0].items.map((i: any) => i.qty)).toEqual([4, 5]);
  });

  it("payload items are exactly the POST body the driver screen sends", () => {
    // The driver screen POSTs `payloads` verbatim (one create-return per order),
    // so this IS the network body — productId is a plain string (never null) and
    // no delivered-side field rides along: the server has no ReturnItem column to
    // persist one, so the B53 x B128 composition is filed separately.
    const result = undeliveredReturnLines(stop);
    expect(result.payloads[0].items).toEqual([
      { productId: "p1", qty: 4, restock: true, reason: "EXCESS_ORDER" },
      { productId: "p2", qty: 5, restock: true, reason: "CUSTOMER_REFUSED" },
    ]);
  });

  it("a free-unit line credits on the box axis — unitsPerBox sizes the free unit", () => {
    // 10 units = 2 boxes × 5, stored $100, 1 FREE BOX. Paid basis = 10 − 1×5 = 5
    // units, so 3 delivered bills $60 and the 7 undelivered credit $40. Read the
    // free unit on the piece axis instead (freeUnitSize 1) and the basis becomes
    // 9 units → $33.33 billed / $66.67 credited: a different, wrong number.
    const boxed = {
      orders: [
        {
          id: "ord-3",
          lineItems: [
            {
              id: "li1",
              productId: "p1",
              qty: 10,
              unitPrice: 10,
              subtotal: 100,
              boxes: 2,
              unitsPerBox: 5,
              freeUnits: 1,
            },
          ],
        },
      ],
      deliveryMutations: [
        { id: "m1", orderItemId: "li1", productId: "p1", type: "PARTIAL", quantityDelivered: 3 },
      ],
    } as any;
    const result = undeliveredReturnLines(boxed);
    expect(result.rows.map((r: any) => ({ qty: r.qty, amount: r.amount }))).toEqual([
      { qty: 7, amount: 40 },
    ]);
  });

  it("a mixed REFUSED + PARTIAL order takes the first row's reason at order level", () => {
    const mixed = {
      orders: [
        {
          id: "ord-2",
          lineItems: [
            { id: "li1", productId: "p1", qty: 4, unitPrice: 10, subtotal: 40 },
            { id: "li2", productId: "p2", qty: 6, unitPrice: 10, subtotal: 60 },
          ],
        },
      ],
      deliveryMutations: [
        { id: "m1", orderItemId: "li1", productId: "p1", type: "REFUSED", quantityDelivered: 0 },
        { id: "m2", orderItemId: "li2", productId: "p2", type: "PARTIAL", quantityDelivered: 2 },
      ],
    } as any;
    const result = undeliveredReturnLines(mixed);
    expect(result.payloads).toHaveLength(1);
    // Order-level reason = the first row's; each item keeps its own reason.
    expect(result.payloads[0].reason).toBe("CUSTOMER_REFUSED");
    expect(result.payloads[0].items.map((i: any) => i.reason)).toEqual([
      "CUSTOMER_REFUSED",
      "EXCESS_ORDER",
    ]);
  });

  it("REG-B61 a damagedKeys row becomes DAMAGED / restock:false and its siblings are untouched", () => {
    // The per-row damaged toggle is the only thing keeping goods that came back
    // broken out of sellable stock on the driver path: exactly the flagged row
    // flips (reason DAMAGED, restock false), every other row keeps the reason
    // derived from its own mutation type and still restocks.
    const result = undeliveredReturnLines(stop, {
      damagedKeys: new Set([undeliveredRowKey("ord-1", "li1")]),
    });
    expect(
      result.rows.map((r) => ({ productId: r.productId, reason: r.reason, restock: r.restock })),
    ).toEqual([
      { productId: "p1", reason: "DAMAGED", restock: false },
      { productId: "p2", reason: "CUSTOMER_REFUSED", restock: true },
    ]);
    // The POST body carries the same override, and the credit math is untouched.
    expect(result.payloads[0].items).toEqual([
      { productId: "p1", qty: 4, restock: false, reason: "DAMAGED" },
      { productId: "p2", qty: 5, restock: true, reason: "CUSTOMER_REFUSED" },
    ]);
    expect(result.total).toBe(90);
  });

  it("a key that matches no row leaves every reason/restock as derived", () => {
    const result = undeliveredReturnLines(stop, {
      damagedKeys: new Set([undeliveredRowKey("ord-1", "li2-not-a-row")]),
    });
    expect(result.rows.map((r) => r.reason)).toEqual(["EXCESS_ORDER", "CUSTOMER_REFUSED"]);
    expect(result.rows.every((r) => r.restock)).toBe(true);
  });

  it("an unlisted line (no catalog product) is dropped from rows/total/payloads and counted", () => {
    // create() matches payload items to order lines by productId, so an item with
    // no product id fails the WHOLE order's return — one ad-hoc line must not take
    // the rest of the order's credit down with it.
    const unlisted = {
      orders: [
        {
          id: "ord-4",
          lineItems: [
            { id: "li1", productId: null, qty: 4, unitPrice: 10, subtotal: 40 },
            { id: "li2", productId: "p2", qty: 6, unitPrice: 10, subtotal: 60 },
          ],
        },
      ],
      deliveryMutations: [
        { id: "m1", orderItemId: "li1", productId: null, type: "REFUSED", quantityDelivered: 0 },
        { id: "m2", orderItemId: "li2", productId: "p2", type: "PARTIAL", quantityDelivered: 2 },
      ],
    } as any;
    const result = undeliveredReturnLines(unlisted);
    expect(result.unlistedCount).toBe(1);
    expect(result.rows.map((r) => r.productId)).toEqual(["p2"]);
    // The dropped line's $40 is NOT in the total and NOT in the POST body.
    expect(result.total).toBe(40);
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0].items).toEqual([
      { productId: "p2", qty: 4, restock: true, reason: "EXCESS_ORDER" },
    ]);
  });
});

describe("summarizeSubmissions", () => {
  it("a fulfilled POST counts done with nothing left to retry", () => {
    expect(summarizeSubmissions([{ orderId: "ord-1", ok: true }])).toEqual({
      done: ["ord-1"],
      failed: [],
    });
  });

  it("the server's cumulative over-return refusal counts DONE, so a retry can clear", () => {
    // That refusal means THIS order's return already exists (create()'s guard).
    // Counted as failed, it is re-POSTed, refused again, and the screen can never
    // reach the success path.
    const result = summarizeSubmissions([
      { orderId: "ord-1", ok: true },
      {
        orderId: "ord-2",
        ok: false,
        message:
          "Return qty (4) exceeds remaining returnable qty (0) for product p1. " +
          "Already returned: 4 of 4.",
      },
    ]);
    expect(result).toEqual({ done: ["ord-1", "ord-2"], failed: [] });
  });

  it("any other rejection stays pending, carrying its own message", () => {
    const result = summarizeSubmissions([
      { orderId: "ord-1", ok: false, message: "Network request failed" },
      { orderId: "ord-2", ok: true },
      { orderId: "ord-3", ok: false },
    ]);
    expect(result.done).toEqual(["ord-2"]);
    expect(result.failed).toEqual([
      { orderId: "ord-1", message: "Network request failed" },
      // A rejection with no message still gets copy the driver can act on.
      { orderId: "ord-3", message: "Try again." },
    ]);
  });

  it("an empty round summarises to nothing done and nothing failed", () => {
    expect(summarizeSubmissions([])).toEqual({ done: [], failed: [] });
  });
});

describe("toUndeliveredStop", () => {
  it("carries boxes/unitsPerBox through and coerces a Decimal-string subtotal to a number", () => {
    const adapted = toUndeliveredStop({
      orders: [
        {
          id: "ord-1",
          lineItems: [
            {
              id: "li1",
              productId: "p1",
              qty: 10,
              unitPrice: 15,
              subtotal: "100.50",
              boxes: 2,
              unitsPerBox: 5,
            },
            { id: "li2", productId: "p2", qty: 3, unitPrice: 10, subtotal: null },
          ],
        },
      ],
      deliveryMutations: [
        { id: "m1", orderItemId: "li1", productId: "p1", type: "PARTIAL", quantityDelivered: 6 },
      ],
    } as any);

    expect(adapted.orders?.[0]?.lineItems?.[0]).toMatchObject({
      id: "li1",
      subtotal: 100.5,
      boxes: 2,
      unitsPerBox: 5,
    });
    // A missing subtotal stays null rather than becoming Number(null) === 0.
    expect(adapted.orders?.[0]?.lineItems?.[1]?.subtotal).toBeNull();
    expect(adapted.deliveryMutations).toHaveLength(1);
  });
});

describe("returnPillFor", () => {
  it("maps every status to a labeled pill (no raw enum leaks)", () => {
    expect(returnPillFor("IN_TRANSIT").label).toBe("In transit");
    expect(returnPillFor("REJECTED").variant).toBe("red");
    expect(returnPillFor("REFUNDED").variant).toBe("green");
    // Unknown status degrades gracefully to gray + the raw string.
    expect(returnPillFor("WEIRD")).toEqual({ variant: "gray", label: "WEIRD" });
  });
});
