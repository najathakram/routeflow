/**
 * B104 (#1395) / #2095 — the buyer-room and tracking reads against a REAL Postgres.
 *
 * `routeflow.gateway.buyer-rooms.spec.ts` proves delivery on a live Socket.IO server over an
 * in-memory Prisma stand-in; `buyer-order-tracking.authz.spec.ts` proves the HTTP chain the same
 * way. What only a real database can prove is that the queries themselves mean what those
 * stand-ins model:
 *
 * - the gateway's link read (`liveBuyerLinkWhere` + the blocked-seller relation filter) returns
 *   exactly the live links, and the HTTP `BuyerSellerContextGuard` (the same predicate) admits
 *   exactly the same (buyer, seller, customer) pairs: a buyer's socket and its portal agree;
 * - the periodic resync drops a link revoked in the database and joins a new one;
 * - #2142 R1: `LIVE_BUYER_ACCOUNT_WHERE` (on its own, and as the `buyerAccount` relation filter
 *   inside that predicate) really refuses a SUSPENDED or DELETED account in SQL: the socket is
 *   disconnected and the portal guard refuses;
 * - the CUSTOMER-role branch resolves its Customer inside its own tenant;
 * - `getOrderTracking`'s include (other stops reduced to number + status) runs, counts an
 *   IN_PROGRESS stop as before you, minimizes the payload for a buyer, and is tenant-scoped by
 *   PrismaService.forTenant().
 *
 * SAFETY: every row lives under throwaway `qa-b104-<sfx>-*` tenants (`assertTestTenant`) or is a
 * BuyerAccount this spec created (`@example.invalid`); `afterAll` deletes exactly those rows, in
 * FK order, tolerant of a half-seeded run. Collected only by `jest.db.config.js` — run via
 * `npm run local:test:db` (point POSTGRES_DB at your own database).
 */
import { randomUUID } from "crypto";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { UserRole } from "@prisma/client";
import { Pool } from "pg";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { BuyerSellerContextGuard } from "../buyer/guards/buyer-seller-context.guard";
import { makePseudoUser } from "../buyer/buyer.controller";
import { getOrderTracking } from "../orders/order-tracking";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { RouteFlowGateway } from "./routeflow.gateway";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC_NAME = "buyer-rooms.db.spec.ts";
const sfx = randomUUID().slice(0, 8);

const T_A = `qa-b104-${sfx}-tenant-a`;
const T_B = `qa-b104-${sfx}-tenant-b`;
const T_S = `qa-b104-${sfx}-tenant-s`;
const TENANT_IDS = [T_A, T_B, T_S];
const SLUG_A = assertTestTenant(`qa-b104-${sfx}-a`, SPEC_NAME);
const SLUG_B = assertTestTenant(`qa-b104-${sfx}-b`, SPEC_NAME);
const SLUG_S = assertTestTenant(`qa-b104-${sfx}-s`, SPEC_NAME);

const BUYER_MINE = randomUUID();
const BUYER_OTHER = randomUUID();
const BUYER_IDS = [BUYER_MINE, BUYER_OTHER];

/** One user + customer per row; `link` is that customer's CustomerLink (or none). */
const CUSTOMERS = {
  mine: { tenant: T_A, buyer: BUYER_MINE, link: "ACTIVE" },
  other: { tenant: T_A, buyer: BUYER_OTHER, link: "ACTIVE" },
  removed: { tenant: T_A, buyer: BUYER_MINE, link: "ACTIVE", removed: true },
  disconnected: { tenant: T_A, buyer: BUYER_MINE, link: "DISCONNECTED" },
  pending: { tenant: T_A, buyer: BUYER_MINE, link: "PENDING_SELLER_APPROVAL" },
  later: { tenant: T_A, buyer: BUYER_MINE, link: "INVITED" },
  mineB: { tenant: T_B, buyer: BUYER_MINE, link: "ACTIVE" },
  suspended: { tenant: T_S, buyer: BUYER_MINE, link: "ACTIVE" },
} as const;
type Key = keyof typeof CUSTOMERS;
const ids = Object.fromEntries(
  Object.keys(CUSTOMERS).map((k) => [k, { user: randomUUID(), customer: randomUUID() }]),
) as Record<Key, { user: string; customer: string }>;

const U_DRIVER = randomUUID();
const DRIVER_ID = randomUUID();
const ROUTE_ID = randomUUID();
const RUN_ID = randomUUID();
const ORDER_MINE = randomUUID();
const ORDER_OTHER = randomUUID();
const SCHEDULED = new Date("2026-09-29T00:00:00.000Z");

const room = (tenantId: string, key: Key) => `tenant:${tenantId}:customer:${ids[key].customer}`;

describeDb("B104 / #2095 — buyer rooms and tracking against real Postgres", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let gateway: RouteFlowGateway;
  let guard: BuyerSellerContextGuard;
  const jwt = new JwtService({ secret: `b104-db-${sfx}` });

  function socketFor(token: string) {
    const id = `sock-${randomUUID().slice(0, 8)}`;
    const rooms = new Set<string>([id]);
    return {
      id,
      rooms,
      data: {} as Record<string, unknown>,
      handshake: { auth: { token }, headers: {} },
      join: (r: string) => void rooms.add(r),
      leave: (r: string) => void rooms.delete(r),
      disconnect: jest.fn(),
    };
  }
  type FakeSocket = ReturnType<typeof socketFor>;
  const roomsOf = (s: FakeSocket) => [...s.rooms].filter((r) => r !== s.id).sort();

  async function connectBuyer(buyerAccountId: string): Promise<FakeSocket> {
    // #2142 R1: a buyer token carries a real exp, as every server-minted one does.
    const s = socketFor(
      jwt.sign(
        { sub: buyerAccountId, email: "b@example.invalid", type: "BUYER" },
        { expiresIn: "15m" },
      ),
    );
    await gateway.handleConnection(s as never);
    return s;
  }

  async function connectCustomerRole(userId: string, tenantId: string): Promise<FakeSocket> {
    // #2164: a CUSTOMER token carries a real exp, as every server-minted one does.
    const s = socketFor(
      jwt.sign(
        {
          sub: userId,
          username: userId,
          role: "CUSTOMER",
          status: "ACTIVE",
          forcePasswordChange: false,
          tenantId,
          tenantSlug: "acme",
        },
        { expiresIn: "15m" },
      ),
    );
    await gateway.handleConnection(s as never);
    return s;
  }

  /** What the HTTP portal guard resolves for this buyer at this seller (null = refused). */
  async function portalCustomer(buyerAccountId: string, slug: string): Promise<string | null> {
    const req: Record<string, any> = {
      user: { sub: buyerAccountId },
      headers: { "x-tenant-slug": slug },
    };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) };
    try {
      await guard.canActivate(ctx as never);
      return req.buyerCustomer.customerId as string;
    } catch (err) {
      if (err instanceof ForbiddenException) return null;
      throw err;
    }
  }

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx); // reads the same DATABASE_URL
    await prisma.$connect();
    gateway = new RouteFlowGateway(jwt, prisma);
    guard = new BuyerSellerContextGuard(prisma);

    for (const [id, slug, status] of [
      [T_A, SLUG_A, "ACTIVE"],
      [T_B, SLUG_B, "TRIAL"],
      [T_S, SLUG_S, "SUSPENDED"],
    ] as const) {
      await prisma.tenant.create({ data: { id, slug, name: `ACME B104 ${slug}`, status } });
    }
    for (const id of BUYER_IDS) {
      await prisma.buyerAccount.create({
        data: { id, email: `${id}@example.invalid`, passwordHash: "x", name: "Sample Buyer" },
      });
    }
    for (const [key, c] of Object.entries(CUSTOMERS) as [
      Key,
      (typeof CUSTOMERS)[Key] & { removed?: boolean },
    ][]) {
      await prisma.user.create({
        data: {
          id: ids[key].user,
          email: `${ids[key].user}@example.invalid`,
          username: ids[key].user,
          role: "CUSTOMER",
          tenantId: c.tenant,
        },
      });
      await prisma.customer.create({
        data: {
          id: ids[key].customer,
          userId: ids[key].user,
          businessName: `Sample ${key}`,
          contactName: "Sample Contact",
          tenantId: c.tenant,
          deliveryWindowStart: "09:00",
          deliveryWindowEnd: "11:30",
          ...(c.removed ? { deletedAt: new Date("2026-09-01T00:00:00.000Z") } : {}),
        },
      });
      await prisma.customerLink.create({
        data: {
          customerId: ids[key].customer,
          tenantId: c.tenant,
          status: c.link,
          buyerAccountId: c.link === "INVITED" ? null : c.buyer,
        },
      });
    }

    // A live run at seller A: stop 1 done, stop 2 being worked, stop 3 pending, stop 4 = mine.
    await prisma.user.create({
      data: {
        id: U_DRIVER,
        email: `${U_DRIVER}@example.invalid`,
        username: U_DRIVER,
        role: "DRIVER",
        tenantId: T_A,
      },
    });
    await prisma.driver.create({
      data: { id: DRIVER_ID, userId: U_DRIVER, contactName: "Sam Rivera", tenantId: T_A },
    });
    await prisma.route.create({ data: { id: ROUTE_ID, name: "Tuesday North", tenantId: T_A } });
    await prisma.routeRun.create({
      data: {
        id: RUN_ID,
        routeId: ROUTE_ID,
        driverId: DRIVER_ID,
        scheduledDate: SCHEDULED,
        status: "IN_PROGRESS",
        tenantId: T_A,
      },
    });
    const stopIds: string[] = [];
    for (const [n, status, key] of [
      [1, "COMPLETED", "other"],
      [2, "IN_PROGRESS", "other"],
      [3, "PENDING", "pending"],
      [4, "PENDING", "mine"],
    ] as const) {
      const routeStop = await prisma.routeStop.create({
        data: { routeId: ROUTE_ID, stopNumber: n, tenantId: T_A },
      });
      const runStop = await prisma.routeRunStop.create({
        data: {
          routeRunId: RUN_ID,
          routeStopId: routeStop.id,
          customerId: ids[key].customer,
          stopNumber: n,
          status,
          podPhotoUrls: [],
          tenantId: T_A,
        },
      });
      stopIds.push(runStop.id);
    }
    await prisma.order.create({
      data: {
        id: ORDER_MINE,
        customerId: ids.mine.customer,
        tenantId: T_A,
        status: "CONFIRMED",
        routeRunId: RUN_ID,
        routeRunStopId: stopIds[3],
      },
    });
    await prisma.order.create({
      data: {
        id: ORDER_OTHER,
        customerId: ids.other.customer,
        tenantId: T_A,
        status: "CONFIRMED",
        routeRunId: RUN_ID,
        routeRunStopId: stopIds[1],
      },
    });
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    const t = [TENANT_IDS];
    await pool.query('DELETE FROM "Order" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "RouteRunStop" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "RouteRun" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "RouteStop" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Route" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Driver" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "CustomerLink" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "Customer" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "User" WHERE "tenantId" = ANY($1::text[])', t);
    await pool.query('DELETE FROM "BuyerAccount" WHERE "id" = ANY($1::text[])', [BUYER_IDS]);
    await pool.query('DELETE FROM "Tenant" WHERE "id" = ANY($1::text[])', t);
    await prisma?.$disconnect();
    await pool.end();
  }, 120_000);

  // ─── Rooms = exactly the live links ─────────────────────────────────────────────

  it("REG-B104: a buyer socket joins exactly its live links' rooms, read from the real tables", async () => {
    const mine = await connectBuyer(BUYER_MINE);
    // DISCONNECTED / PENDING_SELLER_APPROVAL / an unaccepted invite / a removed customer / a
    // SUSPENDED seller grant nothing.
    expect(roomsOf(mine)).toEqual([room(T_A, "mine"), room(T_B, "mineB")].sort());
    expect(mine.disconnect).not.toHaveBeenCalled();

    const other = await connectBuyer(BUYER_OTHER);
    expect(roomsOf(other)).toEqual([room(T_A, "other")]);
  });

  it("REG-B104: the socket and the portal guard agree on every (buyer, seller) pair", async () => {
    const mine = await connectBuyer(BUYER_MINE);
    const other = await connectBuyer(BUYER_OTHER);
    const cases: Array<[string, FakeSocket, string, string]> = [
      [BUYER_MINE, mine, SLUG_A, T_A],
      [BUYER_MINE, mine, SLUG_B, T_B],
      [BUYER_MINE, mine, SLUG_S, T_S],
      [BUYER_OTHER, other, SLUG_A, T_A],
      [BUYER_OTHER, other, SLUG_B, T_B],
    ];
    for (const [buyer, socket, slug, tenantId] of cases) {
      const portal = await portalCustomer(buyer, slug);
      const live = roomsOf(socket).filter((r) => r.startsWith(`tenant:${tenantId}:`));
      expect(live).toEqual(portal ? [`tenant:${tenantId}:customer:${portal}`] : []);
    }
    expect(await portalCustomer(BUYER_MINE, SLUG_A)).toBe(ids.mine.customer);
    expect(await portalCustomer(BUYER_MINE, SLUG_S)).toBeNull();
  });

  it("REG-B104: a revoked link drops out at the next resync, and a new live link joins", async () => {
    const mine = await connectBuyer(BUYER_MINE);
    (gateway as unknown as { server: unknown }).server = {
      local: { fetchSockets: async () => [mine] },
    };
    await pool.query(
      `UPDATE "CustomerLink" SET "status" = 'DISCONNECTED' WHERE "customerId" = $1`,
      [ids.mineB.customer],
    );
    await pool.query(`UPDATE "CustomerLink" SET "status" = 'ACTIVE' WHERE "customerId" = $1`, [
      ids.pending.customer,
    ]);
    try {
      await gateway.resyncBuyerRooms();
      expect(roomsOf(mine)).toEqual([room(T_A, "mine"), room(T_A, "pending")].sort());
    } finally {
      await pool.query(`UPDATE "CustomerLink" SET "status" = 'ACTIVE' WHERE "customerId" = $1`, [
        ids.mineB.customer,
      ]);
      await pool.query(
        `UPDATE "CustomerLink" SET "status" = 'PENDING_SELLER_APPROVAL' WHERE "customerId" = $1`,
        [ids.pending.customer],
      );
    }
  });

  it("#2142 R1: a SUSPENDED or DELETED account's socket is disconnected, and the portal guard refuses it", async () => {
    const setAccount = (status: string, deletedAt: Date | null) =>
      pool.query(
        `UPDATE "BuyerAccount" SET "status" = $2::"BuyerAccountStatus", "deletedAt" = $3
         WHERE "id" = $1`,
        [BUYER_OTHER, status, deletedAt],
      );
    const resyncOnly = async (socket: FakeSocket) => {
      (gateway as unknown as { server: unknown }).server = {
        local: { fetchSockets: async () => [socket] },
      };
      await gateway.resyncBuyerRooms();
    };
    try {
      // What BuyerAdminService.setBuyerStatus writes: the account only; the link stays ACTIVE.
      const live = await connectBuyer(BUYER_OTHER);
      expect(roomsOf(live)).toEqual([room(T_A, "other")]);
      await setAccount("SUSPENDED", null);
      await resyncOnly(live);
      expect(live.disconnect).toHaveBeenCalledWith(true);
      expect(await portalCustomer(BUYER_OTHER, SLUG_A)).toBeNull();
      // A new connection while suspended is refused outright.
      expect((await connectBuyer(BUYER_OTHER)).disconnect).toHaveBeenCalledWith(true);

      await setAccount("DELETED", new Date("2026-09-25T00:00:00.000Z"));
      const beforeDelete = socketFor("unused");
      beforeDelete.data.buyerAccountId = BUYER_OTHER;
      beforeDelete.data.buyerTokenExp = Math.floor(Date.now() / 1000) + 900;
      await resyncOnly(beforeDelete);
      expect(beforeDelete.disconnect).toHaveBeenCalledWith(true);
      expect(await portalCustomer(BUYER_OTHER, SLUG_A)).toBeNull();

      // Reinstated: the untouched link opens both again.
      await setAccount("ACTIVE", null);
      const back = await connectBuyer(BUYER_OTHER);
      expect(back.disconnect).not.toHaveBeenCalled();
      expect(roomsOf(back)).toEqual([room(T_A, "other")]);
      expect(await portalCustomer(BUYER_OTHER, SLUG_A)).toBe(ids.other.customer);
    } finally {
      await setAccount("ACTIVE", null);
    }
    // The other buyer at the same seller was never affected.
    expect(await portalCustomer(BUYER_MINE, SLUG_A)).toBe(ids.mine.customer);
  });

  it("REG-B104: a CUSTOMER-role socket joins its own Customer's room, inside its own tenant only", async () => {
    const mine = await connectCustomerRole(ids.mine.user, T_A);
    expect(roomsOf(mine)).toEqual([room(T_A, "mine")]);
    expect(mine.disconnect).not.toHaveBeenCalled();
    // #2164: the same user claiming another tenant resolves nothing there, and is refused.
    const crossed = await connectCustomerRole(ids.mine.user, T_B);
    expect(roomsOf(crossed)).toEqual([]);
    expect(crossed.disconnect).toHaveBeenCalledWith(true);
    // A removed customer's user resolves nothing (REG-B131), and is refused (#2164).
    const removed = await connectCustomerRole(ids.removed.user, T_A);
    expect(roomsOf(removed)).toEqual([]);
    expect(removed.disconnect).toHaveBeenCalledWith(true);
    // #2164: a user at a SUSPENDED seller is refused too.
    const atSuspended = await connectCustomerRole(ids.suspended.user, T_S);
    expect(atSuspended.disconnect).toHaveBeenCalledWith(true);
  });

  // #1534 / SA-515: the staff re-check's user read EXECUTED on real Postgres (its select —
  // role, tenantId, canActAsDriver — must exist on the row, which a mock cannot prove).
  it("#1534: a staff socket is kept only while its user row matches the token's role, tenant and canActAsDriver", async () => {
    const connectStaff = async (role: string, tenantId: string, extra = {}) => {
      const s = socketFor(
        jwt.sign(
          {
            sub: U_DRIVER,
            username: U_DRIVER,
            role,
            status: "ACTIVE",
            forcePasswordChange: false,
            tenantId,
            tenantSlug: "acme",
            ...extra,
          },
          { expiresIn: "15m" },
        ),
      );
      await gateway.handleConnection(s as never);
      return s;
    };
    const live = await connectStaff("DRIVER", T_A);
    expect(roomsOf(live)).toEqual([`tenant:${T_A}:driver:${U_DRIVER}`]);
    expect(live.disconnect).not.toHaveBeenCalled();

    for (const [role, tenant, extra] of [
      ["OPERATOR", T_A, {}], // a role other than the row's
      ["DRIVER", T_B, {}], // a tenant other than the row's
      ["DRIVER", T_A, { canActAsDriver: true }], // a canActAsDriver other than the row's
    ] as const) {
      const refused = await connectStaff(role, tenant, extra);
      expect(roomsOf(refused)).toEqual([]);
      expect(refused.disconnect).toHaveBeenCalledWith(true);
    }

    await prisma.user.update({ where: { id: U_DRIVER }, data: { status: "INACTIVE" } });
    try {
      const inactive = await connectStaff("DRIVER", T_A);
      expect(inactive.disconnect).toHaveBeenCalledWith(true);
    } finally {
      await prisma.user.update({ where: { id: U_DRIVER }, data: { status: "ACTIVE" } });
    }
  });

  // #2596 (follow-up to #2593, SA-515c/515d): executed on real Postgres — the absent-claim rule
  // (a token without canActAsDriver asserts nothing, so it is not compared) and the token-TRUE /
  // row-false mismatch at resync. On the pre-fold gateway (exact compare, 4891f55b) the first case
  // disconnects.
  it("#2596: canActAsDriver on real Postgres — an absent claim is not compared; a TRUE claim against a false row ends the socket", async () => {
    const staffSocket = async (extra: Record<string, unknown>) => {
      const s = socketFor(
        jwt.sign(
          {
            sub: U_DRIVER,
            username: U_DRIVER,
            role: "DRIVER",
            status: "ACTIVE",
            forcePasswordChange: false,
            tenantId: T_A,
            tenantSlug: "acme",
            ...extra,
          },
          { expiresIn: "15m" },
        ),
      );
      await gateway.handleConnection(s as never);
      return s;
    };
    const resyncOnly = async (socket: FakeSocket) => {
      (gateway as unknown as { server: unknown }).server = {
        local: { fetchSockets: async () => [socket] },
      };
      await gateway.resyncBuyerRooms();
    };
    const setFlag = (on: boolean) =>
      prisma.user.update({ where: { id: U_DRIVER }, data: { canActAsDriver: on } });

    try {
      // (1) The row has canActAsDriver TRUE; the token carries no claim ⇒ connects and survives.
      await setFlag(true);
      const absent = await staffSocket({});
      expect(roomsOf(absent)).toEqual([`tenant:${T_A}:driver:${U_DRIVER}`]);
      expect(absent.disconnect).not.toHaveBeenCalled();
      await resyncOnly(absent);
      expect(absent.disconnect).not.toHaveBeenCalled();

      // (2) A token asserting TRUE matches now; turning the row's flag OFF ends it at the resync.
      const asserted = await staffSocket({ canActAsDriver: true });
      expect(asserted.disconnect).not.toHaveBeenCalled();
      await setFlag(false);
      await resyncOnly(asserted);
      expect(asserted.disconnect).toHaveBeenCalledWith(true);
    } finally {
      await setFlag(false); // the seeded default
    }
  });

  it("#2164: a connected CUSTOMER socket is disconnected at the next resync when its user, customer or seller stops being live", async () => {
    const resyncOnly = async (socket: FakeSocket) => {
      (gateway as unknown as { server: unknown }).server = {
        local: { fetchSockets: async () => [socket] },
      };
      await gateway.resyncBuyerRooms();
    };
    const u = ids.other.user;
    const c = ids.other.customer;
    const q = (sql: string, id: string) => pool.query(sql, [id]);
    const restore = async () => {
      await q(`UPDATE "User" SET "status" = 'ACTIVE', "deletedAt" = NULL WHERE "id" = $1`, u);
      await q(`UPDATE "Customer" SET "deletedAt" = NULL WHERE "id" = $1`, c);
      await q(`UPDATE "Tenant" SET "status" = 'ACTIVE' WHERE "id" = $1`, T_A);
    };
    const changes: Array<[string, () => Promise<unknown>]> = [
      ["user INACTIVE", () => q(`UPDATE "User" SET "status" = 'INACTIVE' WHERE "id" = $1`, u)],
      ["user SUSPENDED", () => q(`UPDATE "User" SET "status" = 'SUSPENDED' WHERE "id" = $1`, u)],
      ["user deleted", () => q(`UPDATE "User" SET "deletedAt" = now() WHERE "id" = $1`, u)],
      ["customer removed", () => q(`UPDATE "Customer" SET "deletedAt" = now() WHERE "id" = $1`, c)],
      [
        "seller suspended",
        () => q(`UPDATE "Tenant" SET "status" = 'SUSPENDED' WHERE "id" = $1`, T_A),
      ],
    ];
    try {
      for (const [label, change] of changes) {
        const socket = await connectCustomerRole(u, T_A);
        expect([label, roomsOf(socket)]).toEqual([label, [room(T_A, "other")]]);
        await resyncOnly(socket);
        expect([label, socket.disconnect.mock.calls]).toEqual([label, []]);
        await change();
        await resyncOnly(socket);
        expect([label, socket.disconnect.mock.calls]).toEqual([label, [[true]]]);
        await restore();
      }
    } finally {
      await restore();
    }
  });

  // ─── Tracking ───────────────────────────────────────────────────────────────────

  it("#2095: the buyer's tracking counts the stop being worked, and carries only its own facts", async () => {
    const buyer = makePseudoUser({ userId: ids.mine.user, tenantId: T_A, tenantSlug: SLUG_A });
    const result = await tenantCtx.run(T_A, () => getOrderTracking({ prisma }, ORDER_MINE, buyer));
    const stored = await prisma.routeRun.findUniqueOrThrow({ where: { id: RUN_ID } });
    expect(result).toEqual({
      status: "CONFIRMED",
      tracking: {
        runId: RUN_ID,
        routeName: null,
        driverName: "Sam",
        runStatus: "IN_PROGRESS",
        stopNumber: 4,
        stopStatus: "PENDING",
        stopsAhead: 2, // stop 2 (IN_PROGRESS) + stop 3 (PENDING); stop 1 is done
        scheduledDate: stored.scheduledDate.toISOString(),
        estimatedArrivalWindow: { start: "09:00", end: "11:30" },
      },
    });
  });

  it("#2095: staff read the same run with the full driver name and the route label", async () => {
    const staff = {
      sub: U_DRIVER,
      username: "op",
      role: UserRole.OPERATOR,
      status: "ACTIVE" as const,
      forcePasswordChange: false,
      tenantId: T_A,
      tenantSlug: SLUG_A,
    };
    const result = await tenantCtx.run(T_A, () => getOrderTracking({ prisma }, ORDER_MINE, staff));
    expect(result.tracking).toEqual(
      expect.objectContaining({ driverName: "Sam Rivera", routeName: "Tuesday North" }),
    );
  });

  it("#2095: another customer's order is refused, and another seller cannot see the order at all", async () => {
    const buyer = makePseudoUser({ userId: ids.mine.user, tenantId: T_A, tenantSlug: SLUG_A });
    await expect(
      tenantCtx.run(T_A, () => getOrderTracking({ prisma }, ORDER_OTHER, buyer)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const atB = makePseudoUser({ userId: ids.mineB.user, tenantId: T_B, tenantSlug: SLUG_B });
    await expect(
      tenantCtx.run(T_B, () => getOrderTracking({ prisma }, ORDER_MINE, atB)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
