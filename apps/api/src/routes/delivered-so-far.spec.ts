import {
  fetchEvidenceByLine,
  groupEvidenceRowsByLine,
  sumDeliveredSoFar,
} from "./delivered-so-far";

describe("groupEvidenceRowsByLine", () => {
  it("groups raw evidence rows by orderId then orderItemId, keeping them un-summed", () => {
    const rows = [
      {
        orderId: "o1",
        orderItemId: "li1",
        routeRunStopId: "s1",
        type: "PARTIAL",
        quantityDelivered: 3,
      },
      {
        orderId: "o1",
        orderItemId: "li1",
        routeRunStopId: "s2",
        type: "DELIVERED",
        quantityDelivered: 4,
      },
      {
        orderId: "o1",
        orderItemId: "li2",
        routeRunStopId: "s1",
        type: "DELIVERED",
        quantityDelivered: 5,
      },
    ];
    const grouped = groupEvidenceRowsByLine(rows);
    expect(grouped.o1!.li1).toHaveLength(2);
    expect(grouped.o1!.li2).toHaveLength(1);
  });

  it("a row with no orderItemId (free-text) attributes to nothing", () => {
    const rows = [
      {
        orderId: "o1",
        orderItemId: null,
        routeRunStopId: "s1",
        type: "DELIVERED",
        quantityDelivered: 3,
      },
    ];
    expect(groupEvidenceRowsByLine(rows)).toEqual({});
  });
});

describe("sumDeliveredSoFar", () => {
  const rows = [
    {
      orderId: "o1",
      orderItemId: "li1",
      routeRunStopId: "s1",
      type: "DELIVERED",
      quantityDelivered: 7,
    },
    {
      orderId: "o1",
      orderItemId: "li1",
      routeRunStopId: "s2",
      type: "PARTIAL",
      quantityDelivered: 3,
    },
  ];

  it("sums every row when no stop is excluded", () => {
    expect(sumDeliveredSoFar(rows, undefined)).toBe(10);
  });

  it("SA-133: excludes the given stop's own rows from the sum", () => {
    expect(sumDeliveredSoFar(rows, "s1")).toBe(3); // only s2's row counts
    expect(sumDeliveredSoFar(rows, "s2")).toBe(7); // only s1's row counts
  });

  it("a REFUSED row contributes 0, never its own quantityDelivered", () => {
    const refused = [
      {
        orderId: "o1",
        orderItemId: "li1",
        routeRunStopId: "s1",
        type: "REFUSED",
        quantityDelivered: 0,
      },
    ];
    expect(sumDeliveredSoFar(refused, "s2")).toBe(0);
  });

  it("returns 0 for an undefined row set (a line never touched at all)", () => {
    expect(sumDeliveredSoFar(undefined, "s1")).toBe(0);
  });
});

describe("fetchEvidenceByLine", () => {
  it("runs ONE deliveryMutation.findMany across every order id, never per-order", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        orderId: "o1",
        orderItemId: "li1",
        routeRunStopId: "s1",
        type: "DELIVERED",
        quantityDelivered: 6,
      },
    ]);

    const grouped = await fetchEvidenceByLine({ deliveryMutation: { findMany } } as any, [
      "o1",
      "o2",
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.orderId).toEqual({ in: ["o1", "o2"] });
    expect(grouped.o1!.li1).toHaveLength(1);
  });

  it("skips the query entirely when there are no order ids", async () => {
    const findMany = jest.fn();
    const grouped = await fetchEvidenceByLine({ deliveryMutation: { findMany } } as any, []);
    expect(findMany).not.toHaveBeenCalled();
    expect(grouped).toEqual({});
  });
});
