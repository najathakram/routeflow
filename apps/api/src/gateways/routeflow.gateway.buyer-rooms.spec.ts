/**
 * B104 (#1395) — buyer-portal sockets joined no room, so no realtime event ever reached a buyer.
 *
 * `handleConnection` branched on `payload.role` only. A buyer JWT (`type: "BUYER"`, sub =
 * BuyerAccount.id) carries no role and no tenantId, so it verified fine and then matched no
 * branch. The legacy CUSTOMER branch joined `customer:<User.id>`, a room no emitter addresses
 * (they all target `customer:<Customer.id>`).
 *
 * This suite runs the REAL gateway inside a real Nest app on a real Socket.IO server (Nest's own
 * IoAdapter, the same namespace wiring production uses), with real socket.io-client connections
 * and real signed JWTs. The only stand-in is Prisma: an in-memory store that applies the `where`
 * the gateway actually sends and throws on any filter shape it does not model (L-081: a mock that
 * hands back a fixed result cannot see a where-only bug).
 *
 * Negative assertions are made meaningful by ordering, never by waiting: after the events under
 * test, a marker is sent to each client's own socket-id room; Socket.IO delivers a connection's
 * packets in order, so once the marker has arrived every earlier event that was going to arrive
 * has arrived. Every connection is awaited to the end of `handleConnection` first, so a socket
 * cannot pass a negative check merely because its rooms were not joined yet.
 *
 * Fixtures are placeholders (acme-style ids); no live-client data.
 */
import { INestApplication } from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { Test } from "@nestjs/testing";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { PrismaService } from "../prisma/prisma.service";
import { BUYER_ROOM_RESYNC_MS, RouteFlowGateway } from "./routeflow.gateway";

const SECRET = "b104-spec-secret";

// ─── In-memory store + honest Prisma stand-in ─────────────────────────────────

type TenantStatus = "TRIAL" | "ACTIVE" | "READ_ONLY" | "SUSPENDED" | "CANCELLED";
type LinkStatus = "INVITED" | "PENDING_SELLER_APPROVAL" | "ACTIVE" | "DISCONNECTED";

interface Store {
  tenants: Array<{ id: string; status: TenantStatus }>;
  customers: Array<{ id: string; tenantId: string; userId: string; deletedAt: Date | null }>;
  links: Array<{
    buyerAccountId: string | null;
    customerId: string;
    tenantId: string;
    status: LinkStatus;
  }>;
}

function seed(): Store {
  return {
    tenants: [
      { id: "t-1", status: "ACTIVE" },
      { id: "t-2", status: "TRIAL" },
      { id: "t-3", status: "SUSPENDED" },
      { id: "t-4", status: "CANCELLED" },
    ],
    customers: [
      { id: "c-a1", tenantId: "t-1", userId: "u-a1", deletedAt: null },
      { id: "c-a2", tenantId: "t-2", userId: "u-a2", deletedAt: null },
      { id: "c-b", tenantId: "t-1", userId: "u-b", deletedAt: null },
      { id: "c-c", tenantId: "t-2", userId: "u-c", deletedAt: null },
      { id: "c-disc", tenantId: "t-1", userId: "u-disc", deletedAt: null },
      { id: "c-pend", tenantId: "t-1", userId: "u-pend", deletedAt: null },
      { id: "c-removed", tenantId: "t-1", userId: "u-removed", deletedAt: new Date("2026-09-01") },
      { id: "c-susp", tenantId: "t-3", userId: "u-susp", deletedAt: null },
      { id: "c-canc", tenantId: "t-4", userId: "u-canc", deletedAt: null },
      { id: "c-new", tenantId: "t-1", userId: "u-new", deletedAt: null },
    ],
    links: [
      // Buyer A: a live link at two sellers, plus one of every link that must grant nothing.
      { buyerAccountId: "buyer-a", customerId: "c-a1", tenantId: "t-1", status: "ACTIVE" },
      { buyerAccountId: "buyer-a", customerId: "c-a2", tenantId: "t-2", status: "ACTIVE" },
      { buyerAccountId: "buyer-a", customerId: "c-disc", tenantId: "t-1", status: "DISCONNECTED" },
      {
        buyerAccountId: "buyer-a",
        customerId: "c-pend",
        tenantId: "t-1",
        status: "PENDING_SELLER_APPROVAL",
      },
      { buyerAccountId: "buyer-a", customerId: "c-removed", tenantId: "t-1", status: "ACTIVE" },
      { buyerAccountId: "buyer-a", customerId: "c-susp", tenantId: "t-3", status: "ACTIVE" },
      { buyerAccountId: "buyer-a", customerId: "c-canc", tenantId: "t-4", status: "ACTIVE" },
      // Buyer B shares seller t-1 with A; buyer C shares seller t-2 with A.
      { buyerAccountId: "buyer-b", customerId: "c-b", tenantId: "t-1", status: "ACTIVE" },
      { buyerAccountId: "buyer-c", customerId: "c-c", tenantId: "t-2", status: "ACTIVE" },
      // An invite nobody has accepted yet.
      { buyerAccountId: null, customerId: "c-new", tenantId: "t-1", status: "INVITED" },
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

function pick<T extends Record<string, unknown>>(row: T, select: Record<string, boolean>) {
  const out: Record<string, unknown> = {};
  for (const [k, on] of Object.entries(select)) if (on) out[k] = row[k];
  return out;
}

function makePrisma(store: Store) {
  const tenantOf = (id: string) => store.tenants.find((t) => t.id === id)!;
  const customerOf = (id: string) => store.customers.find((c) => c.id === id)!;

  function linkMatches(link: Store["links"][number], where: Record<string, any>): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "buyerAccountId") {
        if (typeof cond === "string") {
          if (link.buyerAccountId !== cond) return false;
        } else if (keysAre(cond, ["in"]) && Array.isArray(cond.in)) {
          if (!cond.in.includes(link.buyerAccountId)) return false;
        } else {
          throw new Error(`stand-in: unsupported buyerAccountId filter ${JSON.stringify(cond)}`);
        }
      } else if (key === "status" || key === "tenantId") {
        if (typeof cond !== "string") throw new Error(`stand-in: unsupported ${key} filter`);
        if (link[key] !== cond) return false;
      } else if (key === "customer") {
        if (!keysAre(cond, ["deletedAt"]) || cond.deletedAt !== null) {
          throw new Error(`stand-in: unsupported customer filter ${JSON.stringify(cond)}`);
        }
        if (customerOf(link.customerId).deletedAt !== null) return false;
      } else if (key === "tenant") {
        if (!keysAre(cond, ["status"]) || !keysAre(cond.status, ["notIn"])) {
          throw new Error(`stand-in: unsupported tenant filter ${JSON.stringify(cond)}`);
        }
        if (cond.status.notIn.includes(tenantOf(link.tenantId).status)) return false;
      } else {
        throw new Error(`stand-in: unsupported CustomerLink filter "${key}"`);
      }
    }
    return true;
  }

  function customerMatches(c: Store["customers"][number], where: Record<string, any>): boolean {
    for (const [key, cond] of Object.entries(where)) {
      if (key === "userId" || key === "tenantId") {
        if (typeof cond !== "string") throw new Error(`stand-in: unsupported ${key} filter`);
        if (c[key] !== cond) return false;
      } else if (key === "deletedAt") {
        if (cond !== null) throw new Error("stand-in: unsupported deletedAt filter");
        if (c.deletedAt !== null) return false;
      } else {
        throw new Error(`stand-in: unsupported Customer filter "${key}"`);
      }
    }
    return true;
  }

  return {
    customerLink: {
      findMany: jest.fn(
        async (args: { where: Record<string, any>; select: Record<string, boolean> }) =>
          store.links.filter((l) => linkMatches(l, args.where)).map((l) => pick(l, args.select)),
      ),
    },
    customer: {
      findFirst: jest.fn(
        async (args: { where: Record<string, any>; select?: Record<string, boolean> }) => {
          const row = store.customers.find((c) => customerMatches(c, args.where));
          if (!row) return null;
          return args.select ? pick(row, args.select) : row;
        },
      ),
    },
  };
}

// ─── Harness ───────────────────────────────────────────────────────────────────

interface Client {
  socket: ClientSocket;
  events: Array<{ event: string; payload: any }>;
}

let app: INestApplication;
let gateway: RouteFlowGateway;
let store: Store;
let prisma: ReturnType<typeof makePrisma>;
let url: string;
let connectionSpy: jest.SpyInstance;
const clients: ClientSocket[] = [];
const jwt = new JwtService({ secret: SECRET });

const buyerToken = (sub: string, extra: Record<string, unknown> = {}) =>
  jwt.sign({ sub, email: `${sub}@example.test`, name: sub, type: "BUYER", ...extra });

const staffToken = (sub: string, role: string, tenantId: string) =>
  jwt.sign({
    sub,
    username: sub,
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId,
    tenantSlug: "acme",
  });

/** Every connection handled so far, to completion (joins included). */
async function settleConnections(): Promise<void> {
  await Promise.all(connectionSpy.mock.results.map((r) => r.value));
}

async function connect(token: string): Promise<Client> {
  const socket = io(url, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  clients.push(socket);
  const events: Client["events"] = [];
  socket.onAny((event: string, payload: unknown) => {
    if (event !== "test.marker") events.push({ event, payload });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  await settleConnections();
  return { socket, events };
}

/** Resolves once everything emitted before this call has reached each client (see header). */
let markerSeq = 0;
async function flush(...targets: Client[]): Promise<void> {
  await Promise.all(
    targets.map(({ socket }) => {
      const marker = `m-${++markerSeq}`;
      const arrived = new Promise<void>((resolve) => {
        const onMarker = (id: string) => {
          if (id !== marker) return;
          socket.off("test.marker", onMarker);
          resolve();
        };
        socket.on("test.marker", onMarker);
      });
      gateway.server.to(socket.id!).emit("test.marker", marker);
      return arrived;
    }),
  );
}

/** The rooms the SERVER holds this client in, minus its own socket-id room. */
async function serverRooms(client: Client): Promise<string[]> {
  const [remote] = await gateway.server.in(client.socket.id!).fetchSockets();
  return [...(remote?.rooms ?? [])].filter((r) => r !== client.socket.id).sort();
}

const orderStatus = (customerId: string) => ({
  orderId: `ord-${customerId}`,
  orderNumber: `ORD-${customerId}`,
  customerId,
  status: "DELIVERED",
  previousStatus: "CONFIRMED",
});

const statusEventsOf = (c: Client) =>
  c.events.filter((e) => e.event === "order.statusChanged").map((e) => e.payload.customerId);

describe("RouteFlowGateway on a live Socket.IO server", () => {
  beforeEach(async () => {
    store = seed();
    prisma = makePrisma(store);
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      providers: [RouteFlowGateway, { provide: PrismaService, useValue: prisma }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    gateway = app.get(RouteFlowGateway);
    connectionSpy = jest.spyOn(gateway, "handleConnection");
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  });

  afterEach(async () => {
    for (const s of clients.splice(0)) s.disconnect();
    await app.close();
  });

  // ─── Connection: exactly the buyer's own rooms ───────────────────────────────

  describe("B104 — a buyer socket joins exactly its own rooms", () => {
    it("REG-B104: joins tenant:<tenantId>:customer:<customerId> for each LIVE link of its own account, and nothing else", async () => {
      const a = await connect(buyerToken("buyer-a"));

      // Two sellers, one live link each. DISCONNECTED / PENDING_SELLER_APPROVAL links, a removed
      // customer (REG-B141) and SUSPENDED / CANCELLED sellers grant nothing: the same rule the
      // HTTP BuyerSellerContextGuard applies on every portal request.
      expect(await serverRooms(a)).toEqual([
        "tenant:t-1:customer:c-a1",
        "tenant:t-2:customer:c-a2",
      ]);
      expect(a.socket.connected).toBe(true);
    });

    it("REG-B104: the rooms come from the verified token's own account, looked up server-side", async () => {
      // A client cannot name its rooms: nothing in the handshake but the signed token is read.
      const b = await connect(buyerToken("buyer-b"));
      expect(await serverRooms(b)).toEqual(["tenant:t-1:customer:c-b"]);
      const asked = prisma.customerLink.findMany.mock.calls.flatMap((c) => {
        const id = c[0].where.buyerAccountId;
        return typeof id === "string" ? [id] : id.in;
      });
      expect(asked).toEqual(["buyer-b"]);
    });

    it("a buyer account with no live link stays connected in no room", async () => {
      const lonely = await connect(buyerToken("buyer-nobody"));
      expect(await serverRooms(lonely)).toEqual([]);
      expect(lonely.socket.connected).toBe(true);
    });

    it("REG-B104: a buyer token never lands in a staff room, even if it carried a role claim", async () => {
      // The server never mints this shape; if one ever appears, the BUYER type still decides.
      const b = await connect(buyerToken("buyer-b", { role: "OPERATOR", tenantId: "t-1" }));
      expect(await serverRooms(b)).toEqual(["tenant:t-1:customer:c-b"]);
    });

    it("a token this server did not sign is refused", async () => {
      const forged = new JwtService({ secret: "someone-else" }).sign({
        sub: "buyer-a",
        type: "BUYER",
      });
      const socket = io(url, {
        auth: { token: forged },
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
      });
      clients.push(socket);
      const reason = await new Promise<string>((resolve) => socket.once("disconnect", resolve));
      expect(reason).toBe("io server disconnect");
    });

    it("the link lookup failing refuses the connection (fails closed)", async () => {
      prisma.customerLink.findMany.mockRejectedValueOnce(new Error("db down"));
      const socket = io(url, {
        auth: { token: buyerToken("buyer-a") },
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
      });
      clients.push(socket);
      const reason = await new Promise<string>((resolve) => socket.once("disconnect", resolve));
      expect(reason).toBe("io server disconnect");
    });
  });

  // ─── Delivery: a buyer never receives another buyer's or another tenant's events ──

  describe("B104 — customer events reach the owning buyer only", () => {
    let a: Client;
    let b: Client;
    let c: Client;
    let operator: Client;

    beforeEach(async () => {
      a = await connect(buyerToken("buyer-a"));
      b = await connect(buyerToken("buyer-b"));
      c = await connect(buyerToken("buyer-c"));
      operator = await connect(staffToken("u-op", "OPERATOR", "t-1"));
    });

    it("REG-B104: an order-status change reaches its own buyer, never another buyer at the same seller or at another seller", async () => {
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-a1"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-b"));
      gateway.emitOrderStatusChanged("t-2", orderStatus("c-c"));
      gateway.emitOrderStatusChanged("t-2", orderStatus("c-a2"));
      await flush(a, b, c, operator);

      expect(statusEventsOf(a)).toEqual(["c-a1", "c-a2"]);
      expect(statusEventsOf(b)).toEqual(["c-b"]);
      expect(statusEventsOf(c)).toEqual(["c-c"]);
      // Operators keep their tenant-wide feed (t-1 only).
      expect(statusEventsOf(operator)).toEqual(["c-a1", "c-b"]);
    });

    it("a customer id replayed under another tenant reaches nobody (rooms are tenant-scoped)", async () => {
      gateway.emitOrderStatusChanged("t-2", orderStatus("c-a1"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-c"));
      await flush(a, b, c);
      expect(statusEventsOf(a)).toEqual([]);
      expect(statusEventsOf(b)).toEqual([]);
      expect(statusEventsOf(c)).toEqual([]);
    });

    it("a link that grants no portal access grants no events either", async () => {
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-disc"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-pend"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-removed"));
      gateway.emitOrderStatusChanged("t-3", orderStatus("c-susp"));
      gateway.emitOrderStatusChanged("t-4", orderStatus("c-canc"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-new"));
      await flush(a, b, c);
      expect(statusEventsOf(a)).toEqual([]);
      expect(statusEventsOf(b)).toEqual([]);
      expect(statusEventsOf(c)).toEqual([]);
    });

    it("invoice and credit-note events follow the same rooms", async () => {
      gateway.emitInvoiceUpdated("t-1", {
        invoiceId: "inv-1",
        invoiceNumber: "INV-1",
        customerId: "c-b",
        status: "SENT",
        total: 10,
      });
      gateway.emitCreditNoteVoided("t-1", {
        creditNoteId: "cn-1",
        creditNoteNumber: "CN-1",
        customerId: "c-a1",
        amount: 5,
      });
      await flush(a, b, c);
      expect(a.events.map((e) => e.event)).toEqual(["creditNote.voided"]);
      expect(b.events.map((e) => e.event)).toEqual(["invoice.updated"]);
      expect(c.events).toEqual([]);
    });

    it("operator-only events never reach a buyer", async () => {
      gateway.emitOrderCreated("t-1", {
        orderId: "ord-9",
        orderNumber: "ORD-9",
        customerId: "c-b",
        customerName: "Sample Buyer Co",
        total: 12,
        urgent: false,
        createdAt: "2026-09-24T12:00:00.000Z",
      });
      await flush(a, b, operator);
      expect(a.events).toEqual([]);
      expect(b.events).toEqual([]);
      expect(operator.events.map((e) => e.event)).toEqual(["order.created"]);
    });
  });

  // ─── The legacy CUSTOMER role: same room key as the emitters ──────────────────

  describe("B104 — CUSTOMER-role sockets join the room the emitters address", () => {
    it("REG-B104: a CUSTOMER-role user joins customer:<its Customer.id>, not customer:<User.id>", async () => {
      const customer = await connect(staffToken("u-b", "CUSTOMER", "t-1"));
      expect(await serverRooms(customer)).toEqual(["tenant:t-1:customer:c-b"]);

      gateway.emitOrderStatusChanged("t-1", orderStatus("c-b"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-a1"));
      await flush(customer);
      expect(statusEventsOf(customer)).toEqual(["c-b"]);
    });

    it("a CUSTOMER-role user whose customer is removed joins nothing", async () => {
      const removed = await connect(staffToken("u-removed", "CUSTOMER", "t-1"));
      expect(await serverRooms(removed)).toEqual([]);
    });

    it("a CUSTOMER-role user is looked up inside its own tenant only", async () => {
      // u-c's customer lives at t-2; a token claiming t-1 resolves nothing there.
      const crossed = await connect(staffToken("u-c", "CUSTOMER", "t-1"));
      expect(await serverRooms(crossed)).toEqual([]);
    });
  });

  // ─── Revocation: a live socket follows link changes ───────────────────────────

  describe("B104 — a connected buyer's rooms follow its links", () => {
    it("REG-B104: a revoked link leaves the buyer's socket at the next resync, and a new link joins it", async () => {
      const a = await connect(buyerToken("buyer-a"));
      const operator = await connect(staffToken("u-op", "OPERATOR", "t-1"));

      store.links.find((l) => l.customerId === "c-a1")!.status = "DISCONNECTED";
      store.links.push({
        buyerAccountId: "buyer-a",
        customerId: "c-new",
        tenantId: "t-1",
        status: "ACTIVE",
      });
      await gateway.resyncBuyerRooms();

      expect(await serverRooms(a)).toEqual([
        "tenant:t-1:customer:c-new",
        "tenant:t-2:customer:c-a2",
      ]);
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-a1"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-new"));
      await flush(a, operator);
      expect(statusEventsOf(a)).toEqual(["c-new"]);
      // Staff sockets are never touched by the buyer resync.
      expect(await serverRooms(operator)).toEqual(["tenant:t-1:operators"]);
    });

    it("a removed customer or a suspended seller drops out at the next resync", async () => {
      const a = await connect(buyerToken("buyer-a"));
      store.customers.find((c) => c.id === "c-a1")!.deletedAt = new Date("2026-09-24");
      store.tenants.find((t) => t.id === "t-2")!.status = "SUSPENDED";
      await gateway.resyncBuyerRooms();
      expect(await serverRooms(a)).toEqual([]);
    });

    it("resync reads every connected buyer in one query, whatever the socket count", async () => {
      await connect(buyerToken("buyer-a"));
      await connect(buyerToken("buyer-a")); // a second tab
      await connect(buyerToken("buyer-b"));
      prisma.customerLink.findMany.mockClear();

      await gateway.resyncBuyerRooms();

      expect(prisma.customerLink.findMany).toHaveBeenCalledTimes(1);
      const ids = prisma.customerLink.findMany.mock.calls[0][0].where.buyerAccountId.in;
      expect([...ids].sort()).toEqual(["buyer-a", "buyer-b"]);
    });

    it("a socket that leaves while its links are being read is not put back into any room", async () => {
      // The resync walks sockets it fetched BEFORE its DB read. A join on one that has since
      // disconnected must not resurrect its id in a room map (socket.io's own cleanup makes
      // join a no-op today; this pins the outcome whatever layer keeps providing it).
      const a = await connect(buyerToken("buyer-a"));
      const id = a.socket.id!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const read = prisma.customerLink.findMany.getMockImplementation()!;
      let readStarted!: () => void;
      const started = new Promise<void>((resolve) => (readStarted = resolve));
      prisma.customerLink.findMany.mockImplementationOnce(async (args) => {
        readStarted();
        await gate;
        return read(args);
      });

      const resync = gateway.resyncBuyerRooms();
      await started;
      a.socket.disconnect();
      // The server has dropped the socket once the namespace no longer lists it.
      for (let i = 0; i < 200 && (await gateway.server.in(id).fetchSockets()).length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(await gateway.server.in(id).fetchSockets()).toHaveLength(0);

      release();
      await resync;
      const rooms = (gateway.server as unknown as { adapter: { rooms: Map<string, Set<string>> } })
        .adapter.rooms;
      const holding = [...rooms.entries()].filter(([, ids]) => ids.has(id)).map(([room]) => room);
      expect(holding).toEqual([]);
    });

    it("a failed resync read keeps the last verified rooms instead of throwing", async () => {
      const a = await connect(buyerToken("buyer-a"));
      prisma.customerLink.findMany.mockRejectedValueOnce(new Error("db down"));
      await expect(gateway.resyncBuyerRooms()).resolves.toBeUndefined();
      expect(await serverRooms(a)).toEqual([
        "tenant:t-1:customer:c-a1",
        "tenant:t-2:customer:c-a2",
      ]);
    });
  });
});

// ─── The resync timer (no server needed) ──────────────────────────────────────

describe("B104 — the buyer-room resync timer", () => {
  afterEach(() => jest.useRealTimers());

  it("runs every BUYER_ROOM_RESYNC_MS once the gateway is up, and stops with the module", () => {
    jest.useFakeTimers();
    const bare = new RouteFlowGateway(jwt, makePrisma(seed()) as unknown as PrismaService);
    const resync = jest.spyOn(bare, "resyncBuyerRooms").mockResolvedValue(undefined);

    bare.afterInit();
    jest.advanceTimersByTime(BUYER_ROOM_RESYNC_MS - 1);
    expect(resync).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(resync).toHaveBeenCalledTimes(1);

    bare.onModuleDestroy();
    jest.advanceTimersByTime(BUYER_ROOM_RESYNC_MS * 3);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("a second init replaces the timer instead of stacking another", () => {
    jest.useFakeTimers();
    const bare = new RouteFlowGateway(jwt, makePrisma(seed()) as unknown as PrismaService);
    const resync = jest.spyOn(bare, "resyncBuyerRooms").mockResolvedValue(undefined);

    bare.afterInit();
    bare.afterInit();
    jest.advanceTimersByTime(BUYER_ROOM_RESYNC_MS);
    expect(resync).toHaveBeenCalledTimes(1);
    bare.onModuleDestroy();
  });
});
