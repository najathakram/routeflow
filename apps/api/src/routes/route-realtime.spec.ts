/**
 * #2095 follow-up — who receives each route-driven realtime event.
 *
 * `RouteRealtime` drives the REAL RouteFlowGateway on a live Socket.IO server (see
 * gateways/testing/live-gateway-harness.ts), reached by real buyer and operator sockets. The only
 * stand-in is Prisma: an in-memory store that applies the `where`/`select` actually sent and throws
 * on any shape it does not model (L-081), so an audience bug in the query cannot hide behind a
 * canned result. The privacy rule under test: a buyer only ever receives its OWN order's events,
 * and `route.progress` carries the run id and nothing else.
 *
 * Fixtures are placeholders (acme-style ids); no live-client data.
 */
import { OrderStatus } from "@prisma/client";
import {
  buyerToken,
  eventNames,
  staffToken,
  startLiveGateway,
  type LiveClient,
  type LiveGateway,
} from "../gateways/testing/live-gateway-harness";
import { RouteRealtime, type RouteOrderRef } from "./route-realtime";

// ─── Store + honest Prisma stand-in ───────────────────────────────────────────

type StopStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";

interface Store {
  tenants: Array<{ id: string; status: string }>;
  customers: Array<{ id: string; tenantId: string; deletedAt: Date | null }>;
  buyerAccounts: Array<{ id: string; status: string; deletedAt: Date | null }>;
  links: Array<{ buyerAccountId: string; customerId: string; tenantId: string; status: string }>;
  stops: Array<{
    id: string;
    routeRunId: string;
    customerId: string | null;
    status: StopStatus;
    orders: Array<{ customerId: string }>;
  }>;
  runs: Array<{
    id: string;
    driver: { id: string; contactName: string | null; user: { username: string } } | null;
  }>;
}

function seed(): Store {
  const customer = (id: string, tenantId = "t-1") => ({ id, tenantId, deletedAt: null });
  const link = (buyerAccountId: string, customerId: string, tenantId = "t-1") => ({
    buyerAccountId,
    customerId,
    tenantId,
    status: "ACTIVE",
  });
  return {
    tenants: [
      { id: "t-1", status: "ACTIVE" },
      { id: "t-2", status: "ACTIVE" },
    ],
    customers: ["c-a1", "c-b", "c-c", "c-d", "c-e"]
      .map((id) => customer(id))
      .concat([customer("c-x", "t-2")]),
    // Every buyer account this suite connects, live (ACTIVE, not deleted) — #2142 R1's gateway
    // check runs on every buyer connect, so a stand-in without this would disconnect them all.
    buyerAccounts: [
      "buyer-a",
      "buyer-b",
      "buyer-c",
      "buyer-d",
      "buyer-e",
      "buyer-x",
      "buyer-multi",
    ].map((id) => ({ id, status: "ACTIVE", deletedAt: null })),
    links: [
      link("buyer-a", "c-a1"),
      link("buyer-b", "c-b"),
      link("buyer-c", "c-c"),
      link("buyer-d", "c-d"),
      link("buyer-e", "c-e"),
      link("buyer-x", "c-x", "t-2"),
      // One buyer account linked to two customers that are both on run-1.
      link("buyer-multi", "c-b"),
      link("buyer-multi", "c-c"),
    ],
    stops: [
      // run-1: s1 just completed; s2 waiting; s3 skipped (its order already released, the stop
      // still names its customer); s4 names no customer but carries c-d's order.
      {
        id: "s1",
        routeRunId: "run-1",
        customerId: "c-a1",
        status: "COMPLETED",
        orders: [{ customerId: "c-a1" }],
      },
      {
        id: "s2",
        routeRunId: "run-1",
        customerId: "c-b",
        status: "PENDING",
        orders: [{ customerId: "c-b" }],
      },
      { id: "s3", routeRunId: "run-1", customerId: "c-c", status: "SKIPPED", orders: [] },
      {
        id: "s4",
        routeRunId: "run-1",
        customerId: null,
        status: "IN_PROGRESS",
        orders: [{ customerId: "c-d" }],
      },
      // Another run of the same seller: its customer must never hear about run-1.
      {
        id: "s9",
        routeRunId: "run-2",
        customerId: "c-e",
        status: "PENDING",
        orders: [{ customerId: "c-e" }],
      },
      // A run whose every stop is done.
      {
        id: "s10",
        routeRunId: "run-3",
        customerId: "c-b",
        status: "COMPLETED",
        orders: [{ customerId: "c-b" }],
      },
    ],
    runs: [
      {
        id: "run-1",
        driver: { id: "drv-1", contactName: "Sam Driver", user: { username: "sam" } },
      },
    ],
  };
}

function keysAre(obj: unknown, keys: string[]): boolean {
  return (
    !!obj &&
    typeof obj === "object" &&
    Object.keys(obj).sort().join(",") === [...keys].sort().join(",")
  );
}

function makePrisma(store: Store) {
  const tenantOf = (id: string) => store.tenants.find((t) => t.id === id)!;
  const customerOf = (id: string) => store.customers.find((c) => c.id === id)!;

  // The gateway's buyer-room read (liveBuyerLinkWhere + the blocked-seller filter).
  function linkMatches(link: Store["links"][number], where: Record<string, any>): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "buyerAccountId") {
        if (typeof cond === "string") {
          if (link.buyerAccountId !== cond) return false;
        } else if (keysAre(cond, ["in"])) {
          if (!cond.in.includes(link.buyerAccountId)) return false;
        } else throw new Error(`stand-in: unsupported buyerAccountId filter`);
      } else if (key === "status") {
        if (typeof cond !== "string") throw new Error("stand-in: unsupported status filter");
        if (link.status !== cond) return false;
      } else if (key === "customer") {
        if (!keysAre(cond, ["deletedAt"]) || cond.deletedAt !== null) {
          throw new Error("stand-in: unsupported customer filter");
        }
        if (customerOf(link.customerId).deletedAt !== null) return false;
      } else if (key === "tenant") {
        if (!keysAre(cond, ["status"]) || !keysAre(cond.status, ["notIn"])) {
          throw new Error("stand-in: unsupported tenant filter");
        }
        if (cond.status.notIn.includes(tenantOf(link.tenantId).status)) return false;
      } else if (key === "buyerAccount") {
        // #2142 R1: liveBuyerLinkWhere also checks the buyer's OWN account is live.
        if (!keysAre(cond, ["status", "deletedAt"])) {
          throw new Error("stand-in: unsupported buyerAccount filter");
        }
        const account = store.buyerAccounts.find((a) => a.id === link.buyerAccountId);
        if (!account || account.status !== cond.status || account.deletedAt !== cond.deletedAt) {
          return false;
        }
      } else throw new Error(`stand-in: unsupported CustomerLink filter "${key}"`);
    }
    return true;
  }

  // RouteRealtime's audience read.
  function stopMatches(stop: Store["stops"][number], where: Record<string, any>): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "routeRunId") {
        if (typeof cond !== "string") throw new Error("stand-in: unsupported routeRunId filter");
        if (stop.routeRunId !== cond) return false;
      } else if (key === "status") {
        if (!keysAre(cond, ["not"])) throw new Error("stand-in: unsupported stop status filter");
        if (stop.status === cond.not) return false;
      } else throw new Error(`stand-in: unsupported RouteRunStop filter "${key}"`);
    }
    return true;
  }

  function selectStop(stop: Store["stops"][number], select: Record<string, any>) {
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(select)) {
      if (key === "customerId" && spec === true) out.customerId = stop.customerId;
      else if (
        key === "orders" &&
        keysAre(spec, ["select"]) &&
        keysAre(spec.select, ["customerId"])
      ) {
        out.orders = stop.orders.map((o) => ({ customerId: o.customerId }));
      } else throw new Error(`stand-in: unsupported RouteRunStop select "${key}"`);
    }
    return out;
  }

  const tenantScoped = {
    routeRunStop: {
      findMany: jest.fn(async (args: { where: Record<string, any>; select: Record<string, any> }) =>
        store.stops
          .filter((s) => stopMatches(s, args.where))
          .map((s) => selectStop(s, args.select)),
      ),
    },
    routeRun: {
      findUnique: jest.fn(async (args: { where: { id: string }; include?: unknown }) => {
        if (!keysAre(args.where, ["id"])) throw new Error("stand-in: unsupported RouteRun where");
        return store.runs.find((r) => r.id === args.where.id) ?? null;
      }),
    },
  };

  // The gateway's own-account read (LIVE_BUYER_ACCOUNT_WHERE, #2142 R1): the account must be
  // ACTIVE and not deleted, or its socket is disconnected before it ever reaches this suite.
  function buyerAccountMatches(
    account: Store["buyerAccounts"][number],
    where: Record<string, any>,
  ): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "id") {
        if (!keysAre(cond, ["in"])) throw new Error("stand-in: unsupported buyerAccount id filter");
        if (!cond.in.includes(account.id)) return false;
      } else if (key === "status") {
        if (typeof cond !== "string")
          throw new Error("stand-in: unsupported buyerAccount status filter");
        if (account.status !== cond) return false;
      } else if (key === "deletedAt") {
        if (cond !== null) throw new Error("stand-in: unsupported buyerAccount deletedAt filter");
        if (account.deletedAt !== null) return false;
      } else throw new Error(`stand-in: unsupported BuyerAccount filter "${key}"`);
    }
    return true;
  }

  // #1534 / SA-515: the gateway re-validates staff sockets against their user row at connect.
  // Exactly the shape it sends; anything else throws (L-081).
  const staffUsers = [
    { id: "u-op1", role: "OPERATOR", tenantId: "t-1", canActAsDriver: false },
    { id: "u-op2", role: "OPERATOR", tenantId: "t-2", canActAsDriver: false },
  ];

  return {
    user: {
      findMany: jest.fn(async (args: { where: Record<string, any> }) => {
        const w = args.where;
        if (
          Object.keys(w).sort().join(",") !== "deletedAt,id,status" ||
          w.status !== "ACTIVE" ||
          w.deletedAt !== null ||
          !Array.isArray(w.id?.in)
        ) {
          throw new Error(`stand-in: unsupported User filter ${JSON.stringify(w)}`);
        }
        return staffUsers.filter((u) => w.id.in.includes(u.id));
      }),
    },
    buyerAccount: {
      findMany: jest.fn(
        async (args: { where: Record<string, any>; select: Record<string, boolean> }) =>
          store.buyerAccounts
            .filter((a) => buyerAccountMatches(a, args.where))
            .map((a) => ({ id: a.id })),
      ),
    },
    customerLink: {
      findMany: jest.fn(
        async (args: { where: Record<string, any>; select: Record<string, boolean> }) =>
          store.links
            .filter((l) => linkMatches(l, args.where))
            .map((l) => ({
              buyerAccountId: l.buyerAccountId,
              tenantId: l.tenantId,
              customerId: l.customerId,
            })),
      ),
    },
    customer: {
      findFirst: jest.fn(async () => {
        throw new Error("stand-in: no CUSTOMER-role socket in this suite");
      }),
    },
    tenantScoped,
    forTenant: jest.fn(() => tenantScoped),
    // RouteRealtime runs inside the seller t-1's request context.
    getTenantId: jest.fn(() => "t-1"),
  };
}

const order = (id: string, customerId: string, status: OrderStatus): RouteOrderRef => ({
  id,
  orderNumber: `ORD-${id}`,
  customerId,
  status,
});

const payloadsOf = (client: LiveClient, event: string) =>
  client.events.filter((e) => e.event === event).map((e) => e.payload);

// ─── Suite ─────────────────────────────────────────────────────────────────────

describe("RouteRealtime → who receives each route event (#2095)", () => {
  let live: LiveGateway;
  let prisma: ReturnType<typeof makePrisma>;
  let logger: { warn: jest.Mock };
  let realtime: RouteRealtime;
  let a: LiveClient, b: LiveClient, c: LiveClient, d: LiveClient, e: LiveClient, x: LiveClient;
  let op1: LiveClient, op2: LiveClient;
  let everyone: LiveClient[];

  beforeEach(async () => {
    prisma = makePrisma(seed());
    live = await startLiveGateway(prisma);
    logger = { warn: jest.fn() };
    realtime = new RouteRealtime(prisma as any, live.gateway, logger);
    a = await live.connect(buyerToken("buyer-a"));
    b = await live.connect(buyerToken("buyer-b"));
    c = await live.connect(buyerToken("buyer-c"));
    d = await live.connect(buyerToken("buyer-d"));
    e = await live.connect(buyerToken("buyer-e"));
    x = await live.connect(buyerToken("buyer-x"));
    op1 = await live.connect(staffToken("u-op1", "OPERATOR", "t-1"));
    op2 = await live.connect(staffToken("u-op2", "OPERATOR", "t-2"));
    everyone = [a, b, c, d, e, x, op1, op2];
  });

  afterEach(async () => {
    await live.close();
  });

  it("a completed stop: its own buyer gets its order's DELIVERED, the run's open stops get { runId } only, operators get the stop", async () => {
    const s1 = {
      id: "s1",
      customerId: "c-a1",
      orders: [order("ord-a1", "c-a1", "OUT_FOR_DELIVERY")],
    };
    await realtime.stopCompleted("run-1", s1, false);
    await live.flush(...everyone);

    // The stop's own buyer: its order's status, nothing about the run (its stop is done).
    expect(eventNames(a)).toEqual(["order.statusChanged"]);
    expect(payloadsOf(a, "order.statusChanged")).toEqual([
      {
        orderId: "ord-a1",
        orderNumber: "ORD-ord-a1",
        customerId: "c-a1",
        status: "DELIVERED",
        previousStatus: "OUT_FOR_DELIVERY",
      },
    ]);

    // The run's other open stops (PENDING, SKIPPED, and a stop that names no customer but carries
    // c-d's order): exactly one route.progress each, the run id and not one field more.
    for (const other of [b, c, d]) {
      expect(eventNames(other)).toEqual(["route.progress"]);
      const [payload] = payloadsOf(other, "route.progress");
      expect(Object.keys(payload)).toEqual(["runId"]);
      expect(payload).toEqual({ runId: "run-1" });
    }

    // Another run's customer and another seller's buyer and operator hear nothing.
    expect(e.events).toEqual([]);
    expect(x.events).toEqual([]);
    expect(op2.events).toEqual([]);

    // The seller's operators: the order status and the stop — never route.progress.
    expect(eventNames(op1)).toEqual(["order.statusChanged", "route.stop.completed"]);
    expect(payloadsOf(op1, "route.stop.completed")).toEqual([
      {
        runId: "run-1",
        stopId: "s1",
        customerId: "c-a1",
        orderId: "ord-a1",
        completedAt: expect.any(String),
      },
    ]);
  });

  it("only orders this completion flipped are announced (a DRAFT, CANCELLED or already-DELIVERED order is not)", async () => {
    const s1 = {
      id: "s1",
      customerId: "c-a1",
      orders: [
        order("ord-draft", "c-a1", "DRAFT"),
        order("ord-cancelled", "c-a1", "CANCELLED"),
        order("ord-done", "c-a1", "DELIVERED"),
        order("ord-live", "c-a1", "CONFIRMED"),
      ],
    };
    await realtime.stopCompleted("run-1", s1, false);
    await live.flush(a, op1);

    expect(payloadsOf(a, "order.statusChanged").map((p) => p.orderId)).toEqual(["ord-live"]);
    expect(payloadsOf(op1, "order.statusChanged").map((p) => p.orderId)).toEqual(["ord-live"]);
    // A multi-order stop names no single order.
    expect(payloadsOf(op1, "route.stop.completed")[0].orderId).toBeUndefined();
  });

  it("the run auto-completing tells the seller's operators its driver finished; a buyer never hears it", async () => {
    const s1 = {
      id: "s1",
      customerId: "c-a1",
      orders: [order("ord-a1", "c-a1", "OUT_FOR_DELIVERY")],
    };
    await realtime.stopCompleted("run-1", s1, true);
    await live.flush(...everyone);

    expect(payloadsOf(op1, "driver.status.updated")).toEqual([
      {
        driverId: "drv-1",
        driverName: "Sam Driver",
        status: "COMPLETED",
        updatedAt: expect.any(String),
      },
    ]);
    for (const buyer of [a, b, c, d, e, x]) {
      expect(eventNames(buyer)).not.toContain("driver.status.updated");
    }
    expect(op2.events).toEqual([]);
  });

  it("a buyer linked to two customers on the run receives route.progress once", async () => {
    const multi = await live.connect(buyerToken("buyer-multi"));
    await realtime.runProgress("run-1");
    await live.flush(multi, b, c);

    expect(eventNames(multi)).toEqual(["route.progress"]);
    expect(eventNames(b)).toEqual(["route.progress"]);
    expect(eventNames(c)).toEqual(["route.progress"]);
  });

  it("a run whose every stop is completed emits nothing", async () => {
    const emit = jest.spyOn(live.gateway, "emitRouteProgress");
    await realtime.runProgress("run-3");
    await live.flush(...everyone);

    expect(emit).not.toHaveBeenCalled();
    for (const client of everyone) expect(client.events).toEqual([]);
  });

  it("route.progress never carries a field beyond runId, whatever the caller passes", async () => {
    live.gateway.emitRouteProgress("t-1", ["c-b"], {
      runId: "run-1",
      customerName: "Sample Buyer Co",
      stopsAhead: 2,
    } as any);
    await live.flush(b);

    expect(payloadsOf(b, "route.progress")).toEqual([{ runId: "run-1" }]);
  });

  it("a reopened stop: its buyer's order goes back to CONFIRMED, and the run's open stops are told", async () => {
    await realtime.stopReopened("run-1", [order("ord-a1", "c-a1", "DELIVERED")]);
    await live.flush(...everyone);

    expect(payloadsOf(a, "order.statusChanged")).toEqual([
      {
        orderId: "ord-a1",
        orderNumber: "ORD-ord-a1",
        customerId: "c-a1",
        status: "CONFIRMED",
        previousStatus: "DELIVERED",
      },
    ]);
    expect(eventNames(op1)).toEqual(["order.statusChanged"]);
    for (const other of [b, c, d]) expect(eventNames(other)).toEqual(["route.progress"]);
    expect(e.events).toEqual([]);
    expect(x.events).toEqual([]);
  });

  describe("never fails the request (the write already committed)", () => {
    it("the audience read failing resolves and logs one warn line naming the run", async () => {
      prisma.tenantScoped.routeRunStop.findMany.mockRejectedValueOnce(new Error("db down"));
      await expect(realtime.runProgress("run-1")).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain("run-1");
    });

    it("one emit throwing does not suppress the others", async () => {
      jest.spyOn(live.gateway, "emitOrderStatusChanged").mockImplementationOnce(() => {
        throw new Error("adapter down");
      });
      const s1 = {
        id: "s1",
        customerId: "c-a1",
        orders: [order("ord-a1", "c-a1", "OUT_FOR_DELIVERY")],
      };

      await expect(realtime.stopCompleted("run-1", s1, false)).resolves.toBeUndefined();
      await live.flush(op1, b);

      expect(eventNames(op1)).toEqual(["route.stop.completed"]);
      expect(eventNames(b)).toEqual(["route.progress"]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain("run-1");
    });
  });

  it("the dead inventory.low.stock emitter is gone", () => {
    expect((live.gateway as unknown as Record<string, unknown>).emitLowStock).toBeUndefined();
  });
});
