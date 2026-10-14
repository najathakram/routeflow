import { judgeFulfilSwitch } from "./fulfil-path-restrictions";

/**
 * Row 510: the fulfil-path switch re-judges every live catalog line at the path it switches TO. The Order lock, the
 * lock-time product-set check and the write are ONE transaction whenever any line was judged, even when the pre-lock
 * read was clean: a line added between that read and the write would otherwise be sold unjudged.
 */
const order = {
  id: "o1",
  status: "PENDING",
  tenantId: "t1",
  customerId: "c1",
  fulfillPath: "ROUTE",
};
const self = (lines: Array<{ id: string; productId: string | null }>) =>
  ({
    prisma: {
      getTenantId: () => "t1",
      forTenant: () => ({ orderItem: { findMany: jest.fn().mockResolvedValue(lines) } }),
    },
  }) as never;
const user = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as never;
/** The choke point's answer for a CLEAN read: nothing breached, nothing stamped. */
const cleanDecision = { active: false, stamps: [], carried: [], heldStamped: new Map() } as never;

describe("judgeFulfilSwitch needsTx", () => {
  it("a CLEAN pre-lock read still needs the transaction: the lock-time product-set check always runs", async () => {
    const judged = await judgeFulfilSwitch(
      self([{ id: "l1", productId: "p1" }]),
      order,
      "PICKUP",
      user,
      jest.fn().mockResolvedValue(cleanDecision),
      undefined,
    );
    expect(judged?.needsTx).toBe(true);
    expect([...(judged?.judged ?? [])]).toEqual(["p1"]);
  });

  it("a stub gate that resolves nothing still needs the transaction", async () => {
    const judged = await judgeFulfilSwitch(
      self([{ id: "l1", productId: "p1" }]),
      order,
      "SHIP",
      user,
      jest.fn().mockResolvedValue(undefined),
      undefined,
    );
    expect(judged?.needsTx).toBe(true);
  });

  it("a DRAFT, a switch to the path the order already has, and an order with no catalog line judge nothing", async () => {
    const gate = jest.fn();
    const withLine = self([{ id: "l1", productId: "p1" }]);
    expect(
      await judgeFulfilSwitch(
        withLine,
        { ...order, status: "DRAFT" },
        "PICKUP",
        user,
        gate,
        undefined,
      ),
    ).toBeNull();
    expect(await judgeFulfilSwitch(withLine, order, "ROUTE", user, gate, undefined)).toBeNull();
    expect(
      await judgeFulfilSwitch(
        self([{ id: "l2", productId: null }]),
        order,
        "PICKUP",
        user,
        gate,
        undefined,
      ),
    ).toBeNull();
    expect(gate).not.toHaveBeenCalled();
  });
});
