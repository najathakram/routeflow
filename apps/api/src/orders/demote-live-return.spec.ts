/**
 * SA-1101 A-5 (B1272) unit rows RO-28 and RO-29: the office demotion out of DELIVERED and the live-return guard.
 *
 *  RO-28  only a REJECTED / CANCELLED return exists: the demotion goes through (the guard counts live returns, not all).
 *  RO-29  every edge out of a POST_DELIVERY status into one outside it is in GUARDED_EXITS, and on each of the three
 *         demotion writes (plain -> CONFIRMED, -> PARTIALLY_DELIVERED, the SHIP-billing marker transaction) the guard's
 *         lock and count come BEFORE the status write. A new exit edge in the transitions table is red until it is
 *         named here and guarded.
 *
 * (RO-30, the caller census, is in returns/live-return-guard.structure.spec.ts.) The fake `tenantTransaction` records
 * the order of the lock (`$executeRaw`), the live-return count and the status write; the live count honours the
 * `notIn` the guard sends, so a guard keyed on "any return" would count the REJECTED row and refuse.
 */
import { OrderStatus } from "@prisma/client";
import { POST_DELIVERY_ORDER_STATUSES } from "../common/terminal-order-statuses";
import { buildStatusUpdateData } from "./order-status-claim";
import { ORDER_STATUS_TRANSITIONS } from "./order-status-transitions";
import { updateStatusWithShipMarker } from "./order-ship-state";

/** The exits from a post-delivery status that must refuse while a live return stands (deliverAgainInTx guards REFUSED). */
const GUARDED_EXITS = [
  "DELIVERED->CONFIRMED",
  "DELIVERED->PARTIALLY_DELIVERED",
  "REFUSED->CONFIRMED",
];

type Event = "lock" | "count" | "write" | "marker";

const makeDb = (returnStatuses: string[]) => {
  const events: Event[] = [];
  const tx: any = {
    $executeRaw: async () => {
      events.push("lock");
      return 1;
    },
    return: {
      count: async ({ where }: any) => {
        events.push("count");
        const dead: string[] = where.status?.notIn ?? [];
        return returnStatuses.filter((s) => !dead.includes(s)).length;
      },
    },
    order: {
      update: async ({ data }: any) => {
        events.push("write");
        return { id: "o1", status: data.status };
      },
    },
    orderItem: { findMany: async () => [], findFirst: async () => null },
    orderRevision: {
      aggregate: async () => ({ _max: { revisionNumber: 0 } }),
      create: async () => {
        events.push("marker");
      },
    },
  };
  const prisma: any = {
    getTenantId: () => "t1",
    forTenant: () => ({
      order: {
        update: async ({ data }: any) => {
          events.push("write");
          return { id: "o1", status: data.status };
        },
      },
    }),
    tenantTransaction: async (fn: (tx: any) => Promise<unknown>) => fn(tx),
  };
  return { events, prisma };
};

const order = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  tenantId: "t1",
  status: OrderStatus.DELIVERED,
  fulfillPath: "PICKUP" as const,
  subtotal: 100,
  tax: 0,
  total: 100,
  deliveredAt: new Date("2026-10-01T12:00:00Z"),
  orderDate: new Date("2026-09-30T12:00:00Z"),
  shippedAt: null,
  notes: null,
  ...over,
});

const demote = (
  db: ReturnType<typeof makeDb>,
  to: OrderStatus,
  o: ReturnType<typeof order>,
  over: { featureConfig?: unknown } = {},
) =>
  updateStatusWithShipMarker(
    { prisma: db.prisma, featureConfig: over.featureConfig as never },
    o as never,
    {
      status: to,
      reason: "office correction",
      deliveries: [{ orderItemId: "li-1", quantityDelivered: 6 }],
    },
    undefined,
    buildStatusUpdateData(o as never, to, { isDeliveredDemotion: true, reason: "x" }),
  );

const SHIP_CFG = { getEffectiveMode: async () => "ship" };
const HAS_RETURN = { response: { code: "ORDER_HAS_RETURN" } };

describe("SA-1101 A-5 RO-28: a dead return does not block the demotion", () => {
  it.each([["REJECTED"], ["CANCELLED"]])(
    "only a %s return: DELIVERED -> CONFIRMED goes through, after the guard's lock and count",
    async (status) => {
      const db = makeDb([status]);
      const row: any = await demote(db, OrderStatus.CONFIRMED, order());
      expect(row.status).toBe("CONFIRMED");
      expect(db.events).toEqual(["lock", "count", "write"]);
    },
  );

  it("a live (RECEIVED) return beside a REJECTED one still blocks", async () => {
    const db = makeDb(["REJECTED", "RECEIVED"]);
    await expect(demote(db, OrderStatus.CONFIRMED, order())).rejects.toMatchObject(HAS_RETURN);
    expect(db.events).toEqual(["lock", "count"]);
  });
});

describe("SA-1101 A-5 RO-29: every exit from a post-delivery status is guarded, before the write", () => {
  it("the transitions table: each edge out of POST_DELIVERY into a non-post-delivery status is in GUARDED_EXITS, and nothing else is", () => {
    const post = new Set<string>(POST_DELIVERY_ORDER_STATUSES);
    const exits = Object.entries(ORDER_STATUS_TRANSITIONS)
      .filter(([from]) => post.has(from))
      .flatMap(([from, tos]) => tos.filter((to) => !post.has(to)).map((to) => `${from}->${to}`))
      .sort();
    expect(exits).toEqual([...GUARDED_EXITS].sort());
  });

  it("-> CONFIRMED (the plain write): lock and count, then refuse; nothing written", async () => {
    const db = makeDb(["RECEIVED"]);
    await expect(demote(db, OrderStatus.CONFIRMED, order())).rejects.toMatchObject(HAS_RETURN);
    expect(db.events).toEqual(["lock", "count"]);
  });

  it("-> PARTIALLY_DELIVERED: lock and count first, refuse before any quantity or status write", async () => {
    const db = makeDb(["PENDING"]);
    await expect(demote(db, OrderStatus.PARTIALLY_DELIVERED, order())).rejects.toMatchObject(
      HAS_RETURN,
    );
    expect(db.events).toEqual(["lock", "count"]);
  });

  it.each([[OrderStatus.CONFIRMED], [OrderStatus.PARTIALLY_DELIVERED]])(
    "the SHIP-billing marker transaction (-> %s): lock and count first; no status write, no marker row",
    async (to) => {
      const db = makeDb(["APPROVED"]);
      await expect(
        demote(db, to, order({ fulfillPath: "SHIP" }), { featureConfig: SHIP_CFG }),
      ).rejects.toMatchObject(HAS_RETURN);
      expect(db.events).toEqual(["lock", "count"]);
    },
  );

  it("a demotion that does not start at DELIVERED takes no guard (OUT_FOR_DELIVERY -> CONFIRMED stays the plain write)", async () => {
    const db = makeDb(["RECEIVED"]);
    const row: any = await demote(
      db,
      OrderStatus.CONFIRMED,
      order({ status: OrderStatus.OUT_FOR_DELIVERY }),
    );
    expect(row.status).toBe("CONFIRMED");
    expect(db.events).toEqual(["write"]);
  });

  it("the message is the A-5 sentence, with the shared code", async () => {
    const db = makeDb(["RECEIVED"]);
    await expect(demote(db, OrderStatus.CONFIRMED, order())).rejects.toMatchObject({
      response: {
        code: "ORDER_HAS_RETURN",
        message: "This order has a return. To change its delivery status, cancel the return first.",
      },
    });
  });
});
