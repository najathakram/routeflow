import {
  attachDeliveredSoFar,
  withDeliveredSoFar,
  withDeliveredSoFarForRunsPage,
} from "./run-delivered-so-far";

describe("attachDeliveredSoFar", () => {
  it("sums a line's evidence rows, excluding the STOP's OWN rows (SA-133)", () => {
    const stops = [
      {
        id: "stop-1",
        orders: [{ id: "o1", lineItems: [{ id: "li1", qty: 10 }] }],
      },
    ];
    const evidenceByLine = {
      o1: {
        li1: [
          {
            orderId: "o1",
            orderItemId: "li1",
            routeRunStopId: "stop-1",
            type: "DELIVERED",
            quantityDelivered: 7,
          },
          {
            orderId: "o1",
            orderItemId: "li1",
            routeRunStopId: "stop-0",
            type: "PARTIAL",
            quantityDelivered: 3,
          },
        ],
      },
    };

    const out = attachDeliveredSoFar(stops, evidenceByLine);

    // stop-1's OWN row (7) is excluded from stop-1's own view — only the OTHER stop's 3 counts.
    expect(out[0]!.orders[0]!.lineItems[0]).toEqual({
      id: "li1",
      qty: 10,
      deliveredSoFar: 3,
      remaining: 7,
    });
  });

  it("defaults to 0 for a line absent from the group (never delivered anywhere)", () => {
    const stops = [
      {
        id: "stop-1",
        orders: [
          {
            id: "o1",
            lineItems: [
              { id: "li1", qty: 10 },
              { id: "li2", qty: 10 },
            ],
          },
        ],
      },
    ];
    const out = attachDeliveredSoFar(stops, { o1: { li1: [] } });
    expect(out[0]!.orders[0]!.lineItems).toEqual([
      { id: "li1", qty: 10, deliveredSoFar: 0, remaining: 10 },
      { id: "li2", qty: 10, deliveredSoFar: 0, remaining: 10 },
    ]);
  });

  it("handles a stop with no orders and an order with no lineItems", () => {
    expect(attachDeliveredSoFar([{ id: "s1", orders: undefined }], {})).toEqual([
      { id: "s1", orders: [] },
    ]);
    const out = attachDeliveredSoFar(
      [
        {
          id: "s1",
          orders: [
            { id: "o1", lineItems: undefined as { id: string; qty?: unknown }[] | undefined },
          ],
        },
      ],
      {},
    );
    expect(out[0]!.orders[0]!.lineItems).toEqual([]);
  });
});

describe("withDeliveredSoFar (batched orchestration)", () => {
  it("runs ONE deliveryMutation.findMany across every order id, never per-order, then excludes each stop's own rows", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        orderId: "o1",
        orderItemId: "li1",
        routeRunStopId: "stop-1",
        type: "DELIVERED",
        quantityDelivered: 6,
      },
    ]);
    const db = { deliveryMutation: { findMany } };
    const stops = [
      { id: "stop-1", orders: [{ id: "o1", lineItems: [{ id: "li1", qty: 10 }] }] },
      { id: "stop-2", orders: [{ id: "o2", lineItems: [{ id: "li2", qty: 10 }] }] },
    ];

    const out = await withDeliveredSoFar(db as any, stops);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.orderId).toEqual({ in: ["o1", "o2"] });
    // stop-1's own row is excluded from stop-1's own view of li1.
    expect(out[0]!.orders[0]!.lineItems[0]).toEqual({
      id: "li1",
      qty: 10,
      deliveredSoFar: 0,
      remaining: 10,
    });
    expect(out[1]!.orders[0]!.lineItems[0]).toEqual({
      id: "li2",
      qty: 10,
      deliveredSoFar: 0,
      remaining: 10,
    });
  });

  it("a DIFFERENT stop viewing the same line sees the other stop's evidence", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        orderId: "o1",
        orderItemId: "li1",
        routeRunStopId: "stop-1",
        type: "DELIVERED",
        quantityDelivered: 6,
      },
    ]);
    const db = { deliveryMutation: { findMany } };
    // Same order/line surfaced at a SECOND stop (a redelivery elsewhere) — its own
    // read must see stop-1's evidence, since it isn't stop-1's own row.
    const stops = [{ id: "stop-2", orders: [{ id: "o1", lineItems: [{ id: "li1", qty: 10 }] }] }];

    const out = await withDeliveredSoFar(db as any, stops);

    expect(out[0]!.orders[0]!.lineItems[0]).toEqual({
      id: "li1",
      qty: 10,
      deliveredSoFar: 6,
      remaining: 4,
    });
  });
});

describe("withDeliveredSoFarForRunsPage", () => {
  it("re-distributes each run's own stops back after ONE page-wide batched query", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        orderId: "o1",
        orderItemId: "li1",
        routeRunStopId: "elsewhere",
        type: "DELIVERED",
        quantityDelivered: 6,
      },
      {
        orderId: "o2",
        orderItemId: "li2",
        routeRunStopId: "elsewhere",
        type: "DELIVERED",
        quantityDelivered: 9,
      },
    ]);
    const runs = [
      {
        id: "run-1",
        stops: [{ id: "stop-1", orders: [{ id: "o1", lineItems: [{ id: "li1", qty: 10 }] }] }],
      },
      {
        id: "run-2",
        stops: [{ id: "stop-2", orders: [{ id: "o2", lineItems: [{ id: "li2", qty: 10 }] }] }],
      },
    ];

    const out = await withDeliveredSoFarForRunsPage(
      { deliveryMutation: { findMany } } as any,
      runs,
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(out[0]!.stops[0]!.orders[0]!.lineItems[0]).toEqual({
      id: "li1",
      qty: 10,
      deliveredSoFar: 6,
      remaining: 4,
    });
    expect(out[1]!.stops[0]!.orders[0]!.lineItems[0]).toEqual({
      id: "li2",
      qty: 10,
      deliveredSoFar: 9,
      remaining: 1,
    });
    // Each run keeps its own id and stop count — the slice never leaks across runs.
    expect(out[0]!.id).toBe("run-1");
    expect(out[0]!.stops).toHaveLength(1);
  });
});
