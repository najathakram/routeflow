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
 * #2142 R1 adds the buyer's own ACCOUNT (suspended / deleted accounts keep ACTIVE links) and the
 * token's EXPIRY (the socket used to outlive it) to what connect and the resync re-check: either
 * one failing DISCONNECTS the socket. N1 keeps DRAFT invoice updates out of the customer's room.
 * Every buyer token here carries a real `exp`.
 *
 * Fixtures are placeholders (acme-style ids); no live-client data.
 */
import { INestApplication } from "@nestjs/common";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { Test } from "@nestjs/testing";
import { io, type Socket as ClientSocket } from "socket.io-client";
import { PrismaService } from "../prisma/prisma.service";
import { InvoicesService } from "../invoices/invoices.service";
import { BUYER_ROOM_RESYNC_MS, RouteFlowGateway } from "./routeflow.gateway";

const SECRET = "b104-spec-secret";

// ─── In-memory store + honest Prisma stand-in ─────────────────────────────────

type TenantStatus = "TRIAL" | "ACTIVE" | "READ_ONLY" | "SUSPENDED" | "CANCELLED";
type LinkStatus = "INVITED" | "PENDING_SELLER_APPROVAL" | "ACTIVE" | "DISCONNECTED";
type AccountStatus = "ACTIVE" | "SUSPENDED" | "DELETED";
type UserStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";

interface Store {
  accounts: Array<{ id: string; status: AccountStatus; deletedAt: Date | null }>;
  /** #2164: the CUSTOMER-role users behind the customers below. */
  users: Array<{
    id: string;
    tenantId: string | null;
    role: string;
    status: UserStatus;
    deletedAt: Date | null;
    /** #1534: staff users only (the token's `canActAsDriver` claim is re-checked against it). */
    canActAsDriver?: boolean;
  }>;
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
    accounts: [
      { id: "buyer-a", status: "ACTIVE", deletedAt: null },
      { id: "buyer-b", status: "ACTIVE", deletedAt: null },
      { id: "buyer-c", status: "ACTIVE", deletedAt: null },
      { id: "buyer-nobody", status: "ACTIVE", deletedAt: null },
    ],
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
      // #2164: CUSTOMER users whose OWN account is not live (their customers are fine).
      { id: "c-inact", tenantId: "t-1", userId: "u-inactive", deletedAt: null },
      { id: "c-uspd", tenantId: "t-1", userId: "u-suspended", deletedAt: null },
      { id: "c-udel", tenantId: "t-1", userId: "u-deleted", deletedAt: null },
    ],
    users: [
      { id: "u-b", tenantId: "t-1", role: "CUSTOMER", status: "ACTIVE", deletedAt: null },
      { id: "u-c", tenantId: "t-2", role: "CUSTOMER", status: "ACTIVE", deletedAt: null },
      { id: "u-removed", tenantId: "t-1", role: "CUSTOMER", status: "ACTIVE", deletedAt: null },
      { id: "u-susp", tenantId: "t-3", role: "CUSTOMER", status: "ACTIVE", deletedAt: null },
      { id: "u-inactive", tenantId: "t-1", role: "CUSTOMER", status: "INACTIVE", deletedAt: null },
      {
        id: "u-suspended",
        tenantId: "t-1",
        role: "CUSTOMER",
        status: "SUSPENDED",
        deletedAt: null,
      },
      {
        id: "u-deleted",
        tenantId: "t-1",
        role: "CUSTOMER",
        status: "ACTIVE",
        deletedAt: new Date("2026-09-01"),
      },
      // #1534: staff users behind the staff tokens (re-checked at connect and every resync).
      { id: "u-op", tenantId: "t-1", role: "OPERATOR", status: "ACTIVE", deletedAt: null },
      { id: "u-admin", tenantId: "t-1", role: "TENANT_ADMIN", status: "ACTIVE", deletedAt: null },
      { id: "u-drv", tenantId: "t-1", role: "DRIVER", status: "ACTIVE", deletedAt: null },
      { id: "u-sa", tenantId: null, role: "SUPER_ADMIN", status: "ACTIVE", deletedAt: null },
      {
        id: "u-op-drv",
        tenantId: "t-1",
        role: "OPERATOR",
        status: "ACTIVE",
        deletedAt: null,
        canActAsDriver: true,
      },
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
  // #1534: `canActAsDriver` is a non-null column (default false) — rows that omit it read false.
  for (const [k, on] of Object.entries(select))
    if (on) out[k] = k === "canActAsDriver" ? (row[k] ?? false) : row[k];
  return out;
}

function makePrisma(store: Store) {
  const tenantOf = (id: string) => store.tenants.find((t) => t.id === id)!;
  const customerOf = (id: string) => store.customers.find((c) => c.id === id)!;
  const accountOf = (id: string | null) => store.accounts.find((a) => a.id === id) ?? null;

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
      } else if (key === "buyerAccount") {
        // #2142 R1: a to-one relation filter; a link with no account (an open invite) fails it.
        if (
          !keysAre(cond, ["status", "deletedAt"]) ||
          cond.status !== "ACTIVE" ||
          cond.deletedAt !== null
        ) {
          throw new Error(`stand-in: unsupported buyerAccount filter ${JSON.stringify(cond)}`);
        }
        const account = accountOf(link.buyerAccountId);
        if (!account || account.status !== "ACTIVE" || account.deletedAt !== null) return false;
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

  function accountMatches(a: Store["accounts"][number], where: Record<string, any>): boolean {
    // #2142 R1: exactly `{ id: { in }, ...LIVE_BUYER_ACCOUNT_WHERE }`; anything else throws.
    if (
      !keysAre(where, ["id", "status", "deletedAt"]) ||
      !keysAre(where.id, ["in"]) ||
      !Array.isArray(where.id.in) ||
      where.status !== "ACTIVE" ||
      where.deletedAt !== null
    ) {
      throw new Error(`stand-in: unsupported BuyerAccount filter ${JSON.stringify(where)}`);
    }
    return where.id.in.includes(a.id) && a.status === "ACTIVE" && a.deletedAt === null;
  }

  // #2164: exactly the shapes the CUSTOMER resync sends; anything else throws (L-081).
  // #1534: plus the staff re-check's shape — live users by id, ANY role (the role is compared in
  // code against the token's, so a role change is seen rather than filtered away).
  function liveUserMatches(u: Store["users"][number], where: Record<string, any>): boolean {
    if (keysAre(where, ["id", "status", "deletedAt"])) {
      if (
        !keysAre(where.id, ["in"]) ||
        !Array.isArray(where.id.in) ||
        where.status !== "ACTIVE" ||
        where.deletedAt !== null
      ) {
        throw new Error(`stand-in: unsupported staff User filter ${JSON.stringify(where)}`);
      }
      return where.id.in.includes(u.id) && u.status === "ACTIVE" && u.deletedAt === null;
    }
    if (
      !keysAre(where, ["id", "role", "status", "deletedAt"]) ||
      !keysAre(where.id, ["in"]) ||
      !Array.isArray(where.id.in) ||
      where.role !== "CUSTOMER" ||
      where.status !== "ACTIVE" ||
      where.deletedAt !== null
    ) {
      throw new Error(`stand-in: unsupported User filter ${JSON.stringify(where)}`);
    }
    return (
      where.id.in.includes(u.id) &&
      u.role === "CUSTOMER" &&
      u.status === "ACTIVE" &&
      u.deletedAt === null
    );
  }

  function liveCustomerMatches(c: Store["customers"][number], where: Record<string, any>) {
    if (
      !keysAre(where, ["userId", "deletedAt", "tenant"]) ||
      !keysAre(where.userId, ["in"]) ||
      !Array.isArray(where.userId.in) ||
      where.deletedAt !== null ||
      !keysAre(where.tenant, ["status"]) ||
      !keysAre(where.tenant.status, ["notIn"])
    ) {
      throw new Error(`stand-in: unsupported Customer findMany filter ${JSON.stringify(where)}`);
    }
    return (
      where.userId.in.includes(c.userId) &&
      c.deletedAt === null &&
      !where.tenant.status.notIn.includes(tenantOf(c.tenantId).status)
    );
  }

  return {
    user: {
      findMany: jest.fn(
        async (args: { where: Record<string, any>; select: Record<string, boolean> }) =>
          store.users
            .filter((u) => liveUserMatches(u, args.where))
            .map((u) => pick(u, args.select)),
      ),
    },
    buyerAccount: {
      findMany: jest.fn(
        async (args: { where: Record<string, any>; select: Record<string, boolean> }) =>
          store.accounts
            .filter((a) => accountMatches(a, args.where))
            .map((a) => pick(a, args.select)),
      ),
    },
    customerLink: {
      findMany: jest.fn(
        async (args: { where: Record<string, any>; select: Record<string, boolean> }) =>
          store.links.filter((l) => linkMatches(l, args.where)).map((l) => pick(l, args.select)),
      ),
    },
    customer: {
      findMany: jest.fn(
        async (args: { where: Record<string, any>; select: Record<string, boolean> }) =>
          store.customers
            .filter((c) => liveCustomerMatches(c, args.where))
            .map((c) => pick(c, args.select)),
      ),
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

/** A buyer access token as the server mints it: 15 minutes (JWT_EXPIRES_IN's default). */
const buyerToken = (sub: string, extra: Record<string, unknown> = {}) =>
  jwt.sign(
    { sub, email: `${sub}@example.test`, name: sub, type: "BUYER", ...extra },
    { expiresIn: "15m" },
  );

/** A buyer token that expires at exactly `exp` (seconds since the epoch). */
const buyerTokenExpiringAt = (sub: string, exp: number) =>
  jwt.sign({ sub, email: `${sub}@example.test`, name: sub, type: "BUYER", exp });

/** Runs `fn` with the gateway's clock (Date.now) standing at `ms`, then restores it. */
async function atClock<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const clock = jest.spyOn(Date, "now").mockReturnValue(ms);
  try {
    return await fn();
  } finally {
    clock.mockRestore();
  }
}

/** Resolves with the reason the client was disconnected. */
const disconnected = (client: Client) =>
  new Promise<string>((resolve) => client.socket.once("disconnect", resolve));

/** Whether the server still holds a socket with this id. */
async function serverHolds(id: string): Promise<boolean> {
  return (await gateway.server.in(id).fetchSockets()).length > 0;
}

/**
 * Connects, lets `handleConnection` finish, and reports whether the server kept the socket.
 * Socket.IO acknowledges the connection before the gateway's auth runs, so "connect" always
 * arrives; a refusal is the server dropping it inside `handleConnection`.
 */
async function keptAfterConnect(token: string): Promise<{ kept: boolean; reason: string }> {
  const socket = io(url, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  clients.push(socket);
  const gone = new Promise<string>((resolve) => socket.once("disconnect", resolve));
  // The id is read at "connect": the client forgets it once disconnected.
  const id = await new Promise<string>((resolve, reject) => {
    socket.once("connect", () => resolve(socket.id!));
    socket.once("connect_error", reject);
  });
  await settleConnections();
  const kept = await serverHolds(id);
  if (kept) return { kept, reason: "" };
  return { kept, reason: await gone };
}

const staffToken = (
  sub: string,
  role: string,
  tenantId: string | null,
  extra: Record<string, unknown> = {},
) =>
  jwt.sign({
    sub,
    username: sub,
    role,
    status: "ACTIVE",
    forcePasswordChange: false,
    tenantId,
    tenantSlug: "acme",
    ...extra,
  });

/** #2164: a CUSTOMER-role access token as the server mints it — with a real `exp` (15 minutes). */
const customerToken = (sub: string, tenantId: string, exp?: number) =>
  jwt.sign(
    {
      sub,
      username: sub,
      role: "CUSTOMER",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: "acme",
      ...(exp !== undefined ? { exp } : {}),
    },
    exp !== undefined ? {} : { expiresIn: "15m" },
  );

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

    it("#2142 N1: a DRAFT invoice's update reaches the seller's operators, never the buyer", async () => {
      const invoice = (invoiceId: string, status: string) => ({
        invoiceId,
        invoiceNumber: `INV-${invoiceId}`,
        customerId: "c-b",
        status,
        total: 10,
      });
      gateway.emitInvoiceUpdated("t-1", invoice("draft-1", "DRAFT"));
      gateway.emitInvoiceUpdated("t-1", invoice("sent-1", "SENT"));
      await flush(b, operator);

      expect(b.events.map((e) => e.payload.invoiceId)).toEqual(["sent-1"]);
      expect(operator.events.map((e) => e.payload.invoiceId)).toEqual(["draft-1", "sent-1"]);
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
      const customer = await connect(customerToken("u-b", "t-1"));
      expect(await serverRooms(customer)).toEqual(["tenant:t-1:customer:c-b"]);

      gateway.emitOrderStatusChanged("t-1", orderStatus("c-b"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-a1"));
      await flush(customer);
      expect(statusEventsOf(customer)).toEqual(["c-b"]);
    });

    // #2164: these two used to stay connected in no room; they are now refused outright.
    it("#2164: a CUSTOMER-role user whose customer is removed is refused at connect", async () => {
      expect(await keptAfterConnect(customerToken("u-removed", "t-1"))).toEqual({
        kept: false,
        reason: "io server disconnect",
      });
    });

    it("#2164: a CUSTOMER-role user is looked up inside its own tenant only (refused elsewhere)", async () => {
      // u-c's customer lives at t-2; a token claiming t-1 resolves nothing there.
      expect((await keptAfterConnect(customerToken("u-c", "t-1"))).kept).toBe(false);
    });
  });

  // ─── #2164: CUSTOMER sockets are re-checked like buyer sockets ─────────────────

  describe("#2164 — a CUSTOMER socket is authorized at connect AND at every resync", () => {
    it.each([
      ["an INACTIVE user", "u-inactive"],
      ["a SUSPENDED user", "u-suspended"],
      ["a deleted user", "u-deleted"],
    ])("#2164: %s is refused at connect", async (_label, sub) => {
      expect(await keptAfterConnect(customerToken(sub, "t-1"))).toEqual({
        kept: false,
        reason: "io server disconnect",
      });
    });

    it("#2164: a user at a SUSPENDED seller is refused at connect", async () => {
      expect((await keptAfterConnect(customerToken("u-susp", "t-3"))).kept).toBe(false);
    });

    it("#2164: a CUSTOMER token without an exp is refused; an expired one too", async () => {
      const forever = jwt.sign({ sub: "u-b", role: "CUSTOMER", tenantId: "t-1" });
      expect((await keptAfterConnect(forever)).kept).toBe(false);
      const past = customerToken("u-b", "t-1", Math.floor(Date.now() / 1000) - 1);
      expect((await keptAfterConnect(past)).kept).toBe(false);
    });

    it.each([
      ["no sub", {}],
      ["an empty sub", { sub: "" }],
    ])("#2164 (Opus fold): a CUSTOMER token with %s is refused at connect", async (_l, sub) => {
      // Signed by this server, with a real exp — only the user id is missing. It must be refused,
      // never kept connected in no room.
      const noSub = jwt.sign(
        { ...sub, role: "CUSTOMER", status: "ACTIVE", tenantId: "t-1", tenantSlug: "acme" },
        { expiresIn: "15m" },
      );
      expect(await keptAfterConnect(noSub)).toEqual({
        kept: false,
        reason: "io server disconnect",
      });
    });

    it.each([
      [
        "the user is deactivated",
        () => (store.users.find((u) => u.id === "u-b")!.status = "INACTIVE"),
      ],
      [
        "the user is deleted",
        () => (store.users.find((u) => u.id === "u-b")!.deletedAt = new Date()),
      ],
      [
        "the customer is removed",
        () => (store.customers.find((c) => c.id === "c-b")!.deletedAt = new Date()),
      ],
      [
        "the seller is suspended",
        () => (store.tenants.find((t) => t.id === "t-1")!.status = "SUSPENDED"),
      ],
    ])(
      "#2164: when %s, the connected socket is disconnected at the next resync",
      async (_l, change) => {
        const customer = await connect(customerToken("u-b", "t-1"));
        const other = await connect(customerToken("u-c", "t-2")); // untouched by every change
        const id = customer.socket.id!;
        const gone = disconnected(customer);
        await gateway.resyncBuyerRooms();
        expect(await serverHolds(id)).toBe(true); // nothing changed yet

        change();
        await gateway.resyncBuyerRooms();
        expect(await serverHolds(id)).toBe(false);
        expect(await gone).toBe("io server disconnect");
        expect(other.socket.connected).toBe(true);
        expect(await serverRooms(other)).toEqual(["tenant:t-2:customer:c-c"]);
      },
    );

    it("#2164: at its token's exp the socket is disconnected, even when the DB read fails", async () => {
      const exp = Math.floor(Date.now() / 1000) + 30;
      const customer = await connect(customerToken("u-b", "t-1", exp));
      const id = customer.socket.id!;
      await atClock((exp - 1) * 1000, () => gateway.resyncBuyerRooms());
      expect(await serverHolds(id)).toBe(true);

      prisma.user.findMany.mockRejectedValueOnce(new Error("db down"));
      await atClock(exp * 1000, () => gateway.resyncBuyerRooms());
      expect(await serverHolds(id)).toBe(false);
    });

    it("#2164: a failed read keeps the last verified state (nobody else is disconnected)", async () => {
      const customer = await connect(customerToken("u-b", "t-1"));
      store.users.find((u) => u.id === "u-b")!.status = "INACTIVE";
      prisma.customer.findMany.mockRejectedValueOnce(new Error("db down"));
      await expect(gateway.resyncBuyerRooms()).resolves.toBeUndefined();
      expect(await serverHolds(customer.socket.id!)).toBe(true);
      // The next good read applies the change.
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(customer.socket.id!)).toBe(false);
    });

    it("#2164: the resync reads every connected CUSTOMER user in one query, whatever the socket count", async () => {
      await connect(customerToken("u-b", "t-1"));
      await connect(customerToken("u-b", "t-1")); // a second tab
      await connect(customerToken("u-c", "t-2"));
      prisma.user.findMany.mockClear();
      prisma.customer.findMany.mockClear();
      await gateway.resyncBuyerRooms();
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.customer.findMany).toHaveBeenCalledTimes(1);
    });

    it("a buyer failure does not stop the CUSTOMER check, and the reverse", async () => {
      const buyer = await connect(buyerToken("buyer-a"));
      const customer = await connect(customerToken("u-b", "t-1"));
      store.users.find((u) => u.id === "u-b")!.status = "INACTIVE";
      prisma.customerLink.findMany.mockRejectedValueOnce(new Error("links down"));
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(customer.socket.id!)).toBe(false);
      expect(buyer.socket.connected).toBe(true);
    });

    it("staff sockets are never ended by the EXPIRY check (#1534 adds no staff kick; #2588)", async () => {
      const operator = await connect(staffToken("u-op", "OPERATOR", "t-1"));
      await atClock(Date.now() + 24 * 60 * 60 * 1000, () => gateway.resyncBuyerRooms());
      expect(await serverRooms(operator)).toEqual(["tenant:t-1:operators"]);
    });
  });

  // ─── Revocation: a live socket follows link changes ───────────────────────────

  describe("#1534 — a staff socket is re-validated at connect AND at every resync (SA-515)", () => {
    const user = (id: string) => store.users.find((u) => u.id === id)!;

    it.each([
      ["OPERATOR", "u-op", "t-1", ["tenant:t-1:operators"]],
      ["TENANT_ADMIN", "u-admin", "t-1", ["tenant:t-1:operators"]],
      ["DRIVER", "u-drv", "t-1", ["tenant:t-1:driver:u-drv"]],
      ["SUPER_ADMIN", "u-sa", null, ["super-admin"]],
    ])("control: a live %s joins its room", async (role, sub, tenantId, rooms) => {
      const client = await connect(staffToken(sub, role, tenantId as string | null));
      expect(await serverRooms(client)).toEqual(rooms);
    });

    it.each([
      [
        "an INACTIVE user",
        () => (user("u-op").status = "INACTIVE"),
        staffToken("u-op", "OPERATOR", "t-1"),
      ],
      [
        "a SUSPENDED user",
        () => (user("u-op").status = "SUSPENDED"),
        staffToken("u-op", "OPERATOR", "t-1"),
      ],
      [
        "a deleted user",
        () => (user("u-op").deletedAt = new Date()),
        staffToken("u-op", "OPERATOR", "t-1"),
      ],
      ["a user with no row", () => undefined, staffToken("u-ghost", "OPERATOR", "t-1")],
      ["a role other than the token's", () => undefined, staffToken("u-op", "TENANT_ADMIN", "t-1")],
      ["a tenant other than the token's", () => undefined, staffToken("u-op", "OPERATOR", "t-2")],
      [
        "a canActAsDriver other than the token's",
        () => undefined,
        staffToken("u-op-drv", "OPERATOR", "t-1", { canActAsDriver: false }),
      ],
    ])("#1534: %s is refused at connect", async (_label, change, token) => {
      change();
      expect(await keptAfterConnect(token)).toEqual({
        kept: false,
        reason: "io server disconnect",
      });
    });

    // #1534 fold: a token issued before canActAsDriver was a claim everywhere (or by an issuer that
    // omits it) does not ASSERT it — so it is not compared; only a present claim must match the row.
    it("#1534: a token WITHOUT the canActAsDriver claim, for a row with it true, connects and survives resync", async () => {
      const client = await connect(staffToken("u-op-drv", "OPERATOR", "t-1"));
      expect(await serverRooms(client)).toEqual(["tenant:t-1:operators"]);
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(client.socket.id!)).toBe(true);
    });

    it("#1534: a PRESENT canActAsDriver claim matching the row connects and survives resync", async () => {
      const client = await connect(
        staffToken("u-op-drv", "OPERATOR", "t-1", { canActAsDriver: true }),
      );
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(client.socket.id!)).toBe(true);
    });

    // #2596 (SA-515d nit): the other mismatch direction — the token asserts canActAsDriver TRUE while
    // the row says false — at connect and at resync.
    it("#2596: a token asserting canActAsDriver TRUE for a row with it false is refused at connect", async () => {
      expect(
        await keptAfterConnect(staffToken("u-op", "OPERATOR", "t-1", { canActAsDriver: true })),
      ).toEqual({ kept: false, reason: "io server disconnect" });
    });

    it("#2596: when the row's canActAsDriver is turned OFF under a token asserting TRUE, the socket ends at the next resync", async () => {
      const client = await connect(
        staffToken("u-op-drv", "OPERATOR", "t-1", { canActAsDriver: true }),
      );
      const id = client.socket.id!;
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(id)).toBe(true);
      user("u-op-drv").canActAsDriver = false;
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(id)).toBe(false);
    });

    it("#1534: the user read failing refuses a staff connection (fails closed)", async () => {
      prisma.user.findMany.mockRejectedValueOnce(new Error("db down"));
      expect((await keptAfterConnect(staffToken("u-op", "OPERATOR", "t-1"))).kept).toBe(false);
    });

    it.each([
      ["the user is deactivated", () => (user("u-op").status = "INACTIVE")],
      ["the user is deleted", () => (user("u-op").deletedAt = new Date())],
      ["the user's role changes", () => (user("u-op").role = "TENANT_ADMIN")],
      ["the user moves tenant", () => (user("u-op").tenantId = "t-2")],
      ["canActAsDriver is toggled", () => (user("u-op").canActAsDriver = true)],
    ])(
      "#1534: when %s, the connected staff socket is disconnected at the next resync",
      async (_l, change) => {
        // The token asserts canActAsDriver (as login, refresh and Google tokens do), so a toggle of
        // the row's flag is a mismatch.
        const operator = await connect(
          staffToken("u-op", "OPERATOR", "t-1", { canActAsDriver: false }),
        );
        const admin = await connect(staffToken("u-admin", "TENANT_ADMIN", "t-1")); // untouched
        const buyer = await connect(buyerToken("buyer-a")); // buyer control
        const id = operator.socket.id!;
        const gone = disconnected(operator);
        await gateway.resyncBuyerRooms();
        expect(await serverHolds(id)).toBe(true); // nothing changed yet

        change();
        await gateway.resyncBuyerRooms();
        expect(await serverHolds(id)).toBe(false);
        expect(await gone).toBe("io server disconnect");
        expect(await serverRooms(admin)).toEqual(["tenant:t-1:operators"]);
        expect(buyer.socket.connected).toBe(true);
      },
    );

    it("#1534: a failed staff read keeps the last verified state; the next good read applies it", async () => {
      const operator = await connect(staffToken("u-op", "OPERATOR", "t-1"));
      user("u-op").status = "INACTIVE";
      prisma.user.findMany.mockRejectedValueOnce(new Error("db down"));
      await expect(gateway.resyncBuyerRooms()).resolves.toBeUndefined();
      expect(await serverHolds(operator.socket.id!)).toBe(true);
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(operator.socket.id!)).toBe(false);
    });

    it("#1534: the resync reads every connected staff user in one query, whatever the socket count", async () => {
      await connect(staffToken("u-op", "OPERATOR", "t-1"));
      await connect(staffToken("u-op", "OPERATOR", "t-1")); // a second tab
      await connect(staffToken("u-drv", "DRIVER", "t-1"));
      await connect(staffToken("u-sa", "SUPER_ADMIN", null));
      prisma.user.findMany.mockClear();
      await gateway.resyncBuyerRooms();
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({
        id: { in: expect.arrayContaining(["u-op", "u-drv", "u-sa"]) },
        status: "ACTIVE",
        deletedAt: null,
      });
    });
  });

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

  // ─── #2142 W1: deleting a DRAFT tells the buyer nothing ───────────────────────

  describe("#2142 W1 — InvoicesService.deleteInvoice on the live gateway", () => {
    /**
     * The REAL deleteInvoice, emitting through the live gateway. Its transaction is a stand-in
     * holding one payment-free invoice; the collaborators the delete path calls are no-ops.
     */
    function deleteThrough(status: string) {
      const inv = {
        id: `inv-${status.toLowerCase()}`,
        invoiceNumber: `INV-${status}`,
        customerId: "c-b",
        orderId: null,
        status,
        total: 42,
        payments: [],
      };
      const tx = {
        $executeRaw: jest.fn(async () => 0), // SA-608g: deleteInvoice takes the invoice row lock
        invoice: { findUnique: jest.fn(async () => inv), delete: jest.fn(async () => inv) },
        creditNote: {
          findMany: jest.fn(async () => []),
          updateMany: jest.fn(async () => ({ count: 0 })),
        },
        invoiceItem: {
          findMany: jest.fn(async () => []), // the cash-refund guard reads the invoice's lines
          deleteMany: jest.fn(async () => ({ count: 0 })),
        },
        return: { findFirst: jest.fn(async () => null) }, // ... and finds no cash refund
      };
      const db = {
        tenantTransaction: (fn: (t: typeof tx) => unknown) => fn(tx),
        getTenantId: () => "t-1",
      };
      const none = {} as never;
      const service = new InvoicesService(
        db as never,
        gateway,
        none, // email
        none, // pdf
        none, // system config
        { reverseInvoiceEntries: jest.fn(async () => undefined) } as never,
        none, // authorization guard
        none, // credit notes
        none, // messaging
        none, // storage
        none, // entitlements
        { removeInvoiceCommission: jest.fn(async () => undefined) } as never,
        none, // numbering
        none, // selling restrictions
        none, // entitlement authority (#2241)
      );
      jest
        .spyOn(
          service as unknown as { adjustInvoicedQtyForInvoice: () => Promise<void> },
          "adjustInvoicedQtyForInvoice",
        )
        .mockResolvedValue(undefined);
      return service.deleteInvoice(inv.id);
    }

    it("#2142 W1: a deleted DRAFT reaches the seller's operators, never the buyer's room", async () => {
      const b = await connect(buyerToken("buyer-b"));
      const operator = await connect(staffToken("u-op", "OPERATOR", "t-1"));

      await deleteThrough("DRAFT");
      await flush(b, operator);

      expect(b.events).toEqual([]);
      expect(operator.events).toEqual([
        {
          event: "invoice.updated",
          payload: expect.objectContaining({ invoiceNumber: "INV-DRAFT", status: "DELETED" }),
        },
      ]);
    });

    it("a deleted SENT invoice still reaches the buyer's room", async () => {
      const b = await connect(buyerToken("buyer-b"));
      await deleteThrough("SENT");
      await flush(b);
      expect(b.events).toEqual([
        {
          event: "invoice.updated",
          payload: expect.objectContaining({ invoiceNumber: "INV-SENT", status: "DELETED" }),
        },
      ]);
    });
  });

  // ─── #2142 R1: the account and the token are re-checked too ──────────────────

  describe("#2142 R1 — a buyer socket ends with its own account", () => {
    const account = (id: string) => store.accounts.find((x) => x.id === id)!;

    it("#2142 R1: a SUSPENDED account's socket is refused at connect", async () => {
      account("buyer-a").status = "SUSPENDED";
      expect(await keptAfterConnect(buyerToken("buyer-a"))).toEqual({
        kept: false,
        reason: "io server disconnect",
      });
    });

    it("#2142 R1: suspending a connected buyer disconnects its socket at the next resync", async () => {
      const a = await connect(buyerToken("buyer-a"));
      const b = await connect(buyerToken("buyer-b"));
      const operator = await connect(staffToken("u-op", "OPERATOR", "t-1"));
      const aId = a.socket.id!;
      const aGone = disconnected(a);

      // BuyerAdminService.setBuyerStatus flips the account only; every link stays ACTIVE.
      account("buyer-a").status = "SUSPENDED";
      await gateway.resyncBuyerRooms();

      expect(await serverHolds(aId)).toBe(false);
      expect(await aGone).toBe("io server disconnect");
      const rooms = (gateway.server as unknown as { adapter: { rooms: Map<string, Set<string>> } })
        .adapter.rooms;
      expect([...rooms.values()].some((ids) => ids.has(aId))).toBe(false);

      // Everyone else is untouched.
      expect(b.socket.connected).toBe(true);
      expect(await serverRooms(b)).toEqual(["tenant:t-1:customer:c-b"]);
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-a1"));
      gateway.emitOrderStatusChanged("t-1", orderStatus("c-b"));
      await flush(b, operator);
      expect(a.events).toEqual([]);
      expect(statusEventsOf(b)).toEqual(["c-b"]);
      expect(statusEventsOf(operator)).toEqual(["c-a1", "c-b"]);
    });

    it("#2142 R1: deleting a connected buyer's account disconnects its socket at the next resync", async () => {
      const a = await connect(buyerToken("buyer-a"));
      const aId = a.socket.id!;
      const aGone = disconnected(a);
      // What setBuyerStatus("DELETED"), a self-delete and a merge's secondary all write.
      account("buyer-a").status = "DELETED";
      account("buyer-a").deletedAt = new Date("2026-09-25");
      await gateway.resyncBuyerRooms();

      expect(await serverHolds(aId)).toBe(false);
      expect(await aGone).toBe("io server disconnect");
    });

    it("every tab of a suspended account is disconnected, another account's tab is not", async () => {
      const tab1 = await connect(buyerToken("buyer-a"));
      const tab2 = await connect(buyerToken("buyer-a"));
      const c = await connect(buyerToken("buyer-c"));
      const [id1, id2] = [tab1.socket.id!, tab2.socket.id!];
      account("buyer-a").status = "SUSPENDED";
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(id1)).toBe(false);
      expect(await serverHolds(id2)).toBe(false);
      expect(await serverRooms(c)).toEqual(["tenant:t-2:customer:c-c"]);
    });

    it("a failed account read keeps the last verified state (nobody is disconnected)", async () => {
      const a = await connect(buyerToken("buyer-a"));
      const aId = a.socket.id!;
      account("buyer-a").status = "SUSPENDED";
      prisma.buyerAccount.findMany.mockRejectedValueOnce(new Error("db down"));
      await expect(gateway.resyncBuyerRooms()).resolves.toBeUndefined();
      expect(await serverHolds(aId)).toBe(true);
      // The next tick, with the DB back, ends it.
      await gateway.resyncBuyerRooms();
      expect(await serverHolds(aId)).toBe(false);
    });

    it("a reinstated account can connect again and gets its rooms back", async () => {
      account("buyer-a").status = "SUSPENDED";
      expect((await keptAfterConnect(buyerToken("buyer-a"))).kept).toBe(false);
      account("buyer-a").status = "ACTIVE";
      const a = await connect(buyerToken("buyer-a"));
      expect(await serverRooms(a)).toEqual([
        "tenant:t-1:customer:c-a1",
        "tenant:t-2:customer:c-a2",
      ]);
    });
  });

  describe("#2142 R1 — a buyer socket ends with its token", () => {
    it("#2142 R1: at the first resync from its token's exp the socket is disconnected; a socket with time left is not", async () => {
      const exp = Math.floor(Date.now() / 1000) + 30;
      const a = await connect(buyerTokenExpiringAt("buyer-a", exp));
      const b = await connect(buyerToken("buyer-b")); // 15 minutes left
      const aId = a.socket.id!;
      const aGone = disconnected(a);

      // One second before exp: still valid.
      await atClock((exp - 1) * 1000, () => gateway.resyncBuyerRooms());
      expect(await serverHolds(aId)).toBe(true);
      expect(await serverRooms(a)).toEqual([
        "tenant:t-1:customer:c-a1",
        "tenant:t-2:customer:c-a2",
      ]);

      // At exp: expired (jsonwebtoken's own rule, now >= exp), so the server closes it.
      await atClock(exp * 1000, () => gateway.resyncBuyerRooms());
      expect(await serverHolds(aId)).toBe(false);
      expect(await aGone).toBe("io server disconnect");

      // Nothing addressed to its old rooms can reach it, and the other buyer is untouched.
      const rooms = (gateway.server as unknown as { adapter: { rooms: Map<string, Set<string>> } })
        .adapter.rooms;
      expect([...rooms.values()].some((ids) => ids.has(aId))).toBe(false);
      expect(b.socket.connected).toBe(true);
      expect(await serverRooms(b)).toEqual(["tenant:t-1:customer:c-b"]);
    });

    it("#2142 R1: an expired socket is disconnected even when the link read fails", async () => {
      const exp = Math.floor(Date.now() / 1000) + 30;
      const a = await connect(buyerTokenExpiringAt("buyer-a", exp));
      const aId = a.socket.id!;
      const aGone = disconnected(a);
      prisma.customerLink.findMany.mockRejectedValueOnce(new Error("db down"));

      await atClock((exp + 5) * 1000, () => gateway.resyncBuyerRooms());

      expect(await serverHolds(aId)).toBe(false);
      expect(await aGone).toBe("io server disconnect");
    });

    it("staff sockets are never ended by the buyer expiry check", async () => {
      const operator = await connect(staffToken("u-op", "OPERATOR", "t-1"));
      await atClock(Date.now() + 24 * 60 * 60 * 1000, () => gateway.resyncBuyerRooms());
      expect(await serverHolds(operator.socket.id!)).toBe(true);
      expect(await serverRooms(operator)).toEqual(["tenant:t-1:operators"]);
    });

    it("#2142 R1: a buyer token without an exp is refused at connect", async () => {
      // The server never mints one; a socket on it could never be ended by the resync.
      const forever = jwt.sign({ sub: "buyer-a", email: "a@example.test", type: "BUYER" });
      expect(await keptAfterConnect(forever)).toEqual({
        kept: false,
        reason: "io server disconnect",
      });
    });

    it("an already-expired token is refused at connect", async () => {
      const past = buyerTokenExpiringAt("buyer-a", Math.floor(Date.now() / 1000) - 1);
      expect(await keptAfterConnect(past)).toEqual({ kept: false, reason: "io server disconnect" });
    });

    it("a token with time left is kept", async () => {
      expect((await keptAfterConnect(buyerToken("buyer-a"))).kept).toBe(true);
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
