import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
  WsException,
} from "@nestjs/websockets";
import { Logger, OnModuleDestroy } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Server, Socket } from "socket.io";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { isStaffSessionPayload } from "../auth/session-token";
import { InvoiceStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  BLOCKED_SELLER_STATUSES,
  LIVE_BUYER_ACCOUNT_WHERE,
  liveBuyerLinkWhere,
} from "../buyer/buyer-link-scope";

/**
 * B104: how often every connected buyer socket's rooms are re-derived from its links, so a link
 * revoked (or granted) while a portal tab stays open takes effect within this bound. The HTTP
 * guard re-checks on every request; a socket cannot, so this is the socket's equivalent. It is
 * also the bound on how long a buyer socket outlives its token's `exp` (#2142 R1).
 */
export const BUYER_ROOM_RESYNC_MS = 60_000;

/** #1534: the token roles whose sockets are re-validated against the user row (SA-515). */
const STAFF_ROLES = new Set<string | undefined>([
  UserRole.OPERATOR,
  UserRole.TENANT_ADMIN,
  UserRole.DRIVER,
  UserRole.SUPER_ADMIN,
]);

/** `buyerAccountId: { in }` batch size for the resync read (well under Postgres' bind limit). */
const BUYER_RESYNC_BATCH = 500;

/** The server-side sockets the buyer-room sync reads and moves (this node's own sockets). */
interface RoomMember {
  id: string;
  rooms: Set<string>;
  /**
   * `buyerTokenExp` (#2142 R1) is the verified handshake token's `exp`, in seconds since the
   * epoch: a socket outlives its token, so the resync ends it once that moment has passed.
   */
  data: {
    buyerAccountId?: string;
    buyerTokenExp?: number;
    /** #2164: a CUSTOMER-role socket's verified user, token tenant and token `exp` (seconds). */
    customerUserId?: string;
    customerTenantId?: string | null;
    customerTokenExp?: number;
    /**
     * #1534 / SA-515: a staff socket's verified user and the claims its rooms were granted from
     * (role, tenant, canActAsDriver) — re-checked against the user row at connect and every resync.
     */
    staffUserId?: string;
    staffRole?: string;
    staffTenantId?: string | null;
    staffCanActAsDriver?: boolean;
  };
  join(room: string): unknown;
  leave(room: string): unknown;
  disconnect(close?: boolean): unknown;
}

// ─── Typed event payloads ──────────────────────────────────────────────────────

export interface StopCompletedPayload {
  runId: string;
  stopId: string;
  /** The stop's customer; a run stop's customerId is nullable in the schema. */
  customerId: string | null;
  orderId?: string;
  completedAt: string;
}

/**
 * #2095: a run moved (dispatched, started, a stop arrived/completed/skipped/reopened, stops
 * reordered, the run ended). Carries the run id and nothing else — never a stop, a count, a name
 * or an address — so a buyer's tracking card refetches its OWN figures from the tracking endpoint.
 */
export interface RouteProgressPayload {
  runId: string;
}

export interface UrgentOrderPayload {
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  placedAt: string;
}

export interface DriverStatusPayload {
  driverId: string;
  driverName: string;
  status: string;
  updatedAt: string;
}

export interface DriverLocationPayload {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
}

export interface OrderCreatedPayload {
  orderId: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  total: number;
  urgent: boolean;
  createdAt: string;
}

export interface OrderStatusChangedPayload {
  orderId: string;
  orderNumber: string;
  customerId: string;
  status: string;
  previousStatus: string;
}

export interface ReturnCreatedPayload {
  returnId: string;
  customerId: string;
  customerName: string;
  orderId: string;
  reason: string;
}

export interface InvoiceUpdatedPayload {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  status: string;
  total: number;
}

export interface CreditNoteCreatedPayload {
  creditNoteId: string;
  creditNoteNumber: string;
  customerId: string;
  amount: number;
}

/** B343: voidCreditNote had no socket event at all — a remote void never reached an
 *  open customer statement/credit-notes view. Same shape as the create payload. */
export interface CreditNoteVoidedPayload {
  creditNoteId: string;
  creditNoteNumber: string;
  customerId: string;
  amount: number;
}

export interface RouteDispatchedPayload {
  runId: string;
  routeId: string;
  routeName: string;
  scheduledDate: string;
  stopCount: number;
}

export interface BuyerConnectRequestPayload {
  customerId: string;
  customerName: string;
  buyerName: string;
  buyerEmail: string;
  requestedAt: string;
}

export interface BuyerAutoLinkedPayload {
  customerId: string;
  customerName: string;
  buyerName: string;
  buyerEmail: string;
}

export interface BuyerPaymentRequestPayload {
  requestId: string;
  customerId: string;
  customerName: string;
  kind: "CARD" | "CASH";
  amount: number;
  requestedAt: string;
}

/**
 * A catalog write — a product was created, edited, archived, or bulk-written.
 * Operators-room only: handleConnection joins CUSTOMER sockets to a per-customer
 * room, so no tenant-wide customer room exists to carry this to buyer catalogs.
 */
export interface ProductUpdatedPayload {
  /** The product that changed; null for a bulk write (clients invalidate the family). */
  productId: string | null;
  action: "created" | "updated" | "archived" | "bulk";
}

/** CRM (GoHighLevel) lead handoff — spec R24. Never sent for a dry-run preview. */
export interface CrmHandoffPayload {
  customerId: string;
  customerName: string;
  status: "CREATED" | "LINKED";
  source: "gohighlevel";
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
      : [
          "http://localhost:3001",
          "http://localhost:8081",
          "http://localhost:19000",
          "http://localhost:19006",
        ],
    credentials: true,
  },
  namespace: "/",
})
export class RouteFlowGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  // Declared as Server, but with the `namespace: "/"` option Nest's IoAdapter hands the gateway
  // the root Namespace (`server.of("/")`). Use only the API the two share: to/in/local/fetchSockets.
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RouteFlowGateway.name);
  private buyerResyncTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────────

  afterInit() {
    if (this.buyerResyncTimer) clearInterval(this.buyerResyncTimer);
    this.buyerResyncTimer = setInterval(() => void this.resyncBuyerRooms(), BUYER_ROOM_RESYNC_MS);
    // Never the reason a process stays alive.
    this.buyerResyncTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.buyerResyncTimer) clearInterval(this.buyerResyncTimer);
    this.buyerResyncTimer = null;
  }

  // ─── Room helpers ─────────────────────────────────────────────────────────────

  private tenantRoom(tenantId: string | null, room: string): string {
    return tenantId ? `tenant:${tenantId}:${room}` : room;
  }

  /**
   * The ONE name of a customer's room: every customer-scoped emit targets it and every socket
   * that may read that customer's orders (its buyer accounts, its CUSTOMER-role user) joins it.
   * Keyed by Customer.id (B104: the CUSTOMER branch used to join by User.id, which no emit hit).
   */
  private customerRoom(tenantId: string | null, customerId: string): string {
    return this.tenantRoom(tenantId, `customer:${customerId}`);
  }

  // ─── Connection auth ───────────────────────────────────────────────────────���─

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string)?.replace("Bearer ", "");

      if (!token) throw new WsException("No token");

      const payload = this.jwtService.verify<JwtPayload>(token);

      // B104: a buyer-portal token (sub = BuyerAccount.id) carries no role and no tenantId. Its
      // rooms come only from the verified sub and the DB, never from the handshake, and the BUYER
      // type decides before any role check, so a buyer token can never land in a staff room.
      if (payload.type === "BUYER") {
        if (typeof payload.sub !== "string" || !payload.sub) {
          throw new WsException("Invalid buyer token");
        }
        // #2142 R1: every buyer access token the server mints carries an `exp` (buyer login,
        // Google sign-in, admin impersonation), and the resync ends the socket at that moment.
        // A token without one would keep its socket for ever, so it is refused here.
        const exp = (payload as { exp?: unknown }).exp;
        if (typeof exp !== "number" || !Number.isFinite(exp)) {
          throw new WsException("Buyer token without an expiry");
        }
        const data = client.data as RoomMember["data"];
        data.buyerAccountId = payload.sub;
        data.buyerTokenExp = exp;
        await this.syncBuyerRooms([client]);
        return;
      }

      if (!isStaffSessionPayload(payload)) throw new WsException("Invalid token");

      client.data.user = payload;

      const tenantId = payload.tenantId ?? null;

      // #1534 / SA-515: a staff socket is admitted only while its user row still matches the token
      // (ACTIVE, undeleted, same role, tenant and canActAsDriver) — here and at every resync. A
      // failed read throws, refusing the connection (fails closed).
      if (STAFF_ROLES.has(payload.role)) {
        if (typeof payload.sub !== "string" || !payload.sub) {
          throw new WsException("Invalid staff token");
        }
        const data = client.data as RoomMember["data"];
        data.staffUserId = payload.sub;
        data.staffRole = payload.role;
        data.staffTenantId = tenantId;
        // #1534 fold: only a PRESENT claim is compared — a token that does not carry it (issued
        // before every issuer minted it) asserts nothing about it, so it is not a mismatch.
        data.staffCanActAsDriver =
          typeof payload.canActAsDriver === "boolean" ? payload.canActAsDriver : undefined;
        const [live] = await this.checkStaffSockets([client as unknown as RoomMember]);
        if (!live) return;
      }

      if (payload.role === UserRole.OPERATOR || payload.role === UserRole.TENANT_ADMIN) {
        await client.join(this.tenantRoom(tenantId, "operators"));
      } else if (payload.role === UserRole.DRIVER) {
        await client.join(this.tenantRoom(tenantId, `driver:${payload.sub}`));
      } else if (payload.role === UserRole.CUSTOMER) {
        // B104: the room the emitters address is keyed by the Customer, resolved from the user
        // inside the token's own tenant. #2164: the same rule decides at connect and at every
        // resync (syncCustomerRooms), and like a buyer token it must carry a user id and an `exp`.
        if (typeof payload.sub !== "string" || !payload.sub) {
          throw new WsException("Invalid customer token");
        }
        const exp = (payload as { exp?: unknown }).exp;
        if (typeof exp !== "number" || !Number.isFinite(exp)) {
          throw new WsException("Customer token without an expiry");
        }
        const data = client.data as RoomMember["data"];
        data.customerUserId = payload.sub;
        data.customerTenantId = tenantId;
        data.customerTokenExp = exp;
        await this.syncCustomerRooms([client]);
      } else if (payload.role === UserRole.SUPER_ADMIN) {
        await client.join("super-admin");
      }
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket) {
    // cleanup handled automatically by socket.io
  }

  // ─── Buyer rooms (B104) ───────────────────────────────────────────────────────

  /**
   * Re-derives the rooms of every buyer socket connected to THIS node (each node owns its own
   * sockets; with the Redis adapter, `local` keeps the read off the other nodes). A read failure
   * keeps the last verified rooms: nothing can change a link while the DB is unreachable, and the
   * next tick retries.
   *
   * #2142 R1: first it disconnects every buyer socket whose token has expired. That needs no DB,
   * so it runs before the link read and a DB outage cannot skip it.
   */
  async resyncBuyerRooms(): Promise<void> {
    if (!this.server) return;
    let buyers: RoomMember[];
    let customers: RoomMember[];
    let staff: RoomMember[];
    try {
      const sockets = (await this.server.local.fetchSockets()) as unknown as RoomMember[];
      buyers = sockets.filter((s) => !!s.data?.buyerAccountId);
      customers = sockets.filter((s) => !!s.data?.customerUserId);
      staff = sockets.filter((s) => !!s.data?.staffUserId);
    } catch (err) {
      this.logger.warn(`[B104] buyer room resync skipped: ${(err as Error)?.message ?? err}`);
      return;
    }
    // #2164: CUSTOMER sockets follow the same two steps (expiry first, needing no DB; then the
    // DB re-check), each in its own try so one side's failed read never skips the other.
    const liveBuyers = this.disconnectExpired(buyers, (s) => s.data.buyerTokenExp);
    const liveCustomers = this.disconnectExpired(customers, (s) => s.data.customerTokenExp);
    try {
      await this.syncBuyerRooms(liveBuyers);
    } catch (err) {
      this.logger.warn(`[B104] buyer room resync skipped: ${(err as Error)?.message ?? err}`);
    }
    try {
      await this.syncCustomerRooms(liveCustomers);
    } catch (err) {
      this.logger.warn(`[#2164] customer room resync skipped: ${(err as Error)?.message ?? err}`);
    }
    // #1534 / SA-515: staff sockets get the DB re-check only — no expiry kick until the staff
    // clients can recover from one (#2588). A failed read keeps the last verified state.
    try {
      await this.checkStaffSockets(staff);
    } catch (err) {
      this.logger.warn(`[#1534] staff socket resync skipped: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * Disconnects each socket whose token `exp` has passed (the same `now >= exp` rule the JWT
   * check applies at connect) and returns the rest. `disconnect(true)` closes the transport;
   * socket.io removes a closed socket from every room itself, so no room is left to clean up.
   */
  private disconnectExpired(
    sockets: RoomMember[],
    expOf: (s: RoomMember) => number | undefined,
  ): RoomMember[] {
    const nowSec = Math.floor(Date.now() / 1000); // jsonwebtoken's own clock rule
    const live: RoomMember[] = [];
    for (const socket of sockets) {
      const exp = expOf(socket);
      if (typeof exp !== "number" || nowSec >= exp) {
        socket.disconnect(true);
      } else {
        live.push(socket);
      }
    }
    return live;
  }

  /**
   * Puts each buyer socket in exactly the customer rooms its account's live links grant (the
   * portal guard's own rule, `liveBuyerLinkWhere`, at a seller that is not blocked) and takes it
   * out of every other room. One account read and one link read per batch of accounts, however
   * many sockets they hold.
   *
   * #2142 R1: a socket whose account is no longer live (SUSPENDED, DELETED, gone) is disconnected,
   * at connect as at every resync. Both reads finish before any socket is touched, so a failed
   * read changes nothing (the caller keeps the last verified state, or refuses a new connection).
   */
  private async syncBuyerRooms(sockets: RoomMember[]): Promise<void> {
    const accountIds = [
      ...new Set(sockets.map((s) => s.data.buyerAccountId).filter((id): id is string => !!id)),
    ];
    if (accountIds.length === 0) return;

    const liveAccounts = new Set<string>();
    const granted = new Map<string, Set<string>>();
    for (let i = 0; i < accountIds.length; i += BUYER_RESYNC_BATCH) {
      const batch = accountIds.slice(i, i + BUYER_RESYNC_BATCH);
      const accounts = await this.prisma.buyerAccount.findMany({
        where: { id: { in: batch }, ...LIVE_BUYER_ACCOUNT_WHERE },
        select: { id: true },
      });
      for (const account of accounts) liveAccounts.add(account.id);
      const links = await this.prisma.customerLink.findMany({
        where: {
          ...liveBuyerLinkWhere({ in: batch }),
          tenant: { status: { notIn: [...BLOCKED_SELLER_STATUSES] } },
        },
        select: { buyerAccountId: true, tenantId: true, customerId: true },
      });
      for (const link of links) {
        if (!link.buyerAccountId) continue;
        const rooms = granted.get(link.buyerAccountId) ?? new Set<string>();
        rooms.add(this.customerRoom(link.tenantId, link.customerId));
        granted.set(link.buyerAccountId, rooms);
      }
    }

    // A socket that disconnected while the links were read is safe to walk: socket.io's cleanup
    // turns its join() into a no-op, so it cannot be put back into a room (pinned by the spec).
    for (const socket of sockets) {
      if (!liveAccounts.has(socket.data.buyerAccountId ?? "")) {
        // disconnect(true) closes the transport; socket.io drops a closed socket from every room.
        socket.disconnect(true);
        continue;
      }
      const want = granted.get(socket.data.buyerAccountId ?? "") ?? new Set<string>();
      for (const room of [...socket.rooms]) {
        if (room !== socket.id && !want.has(room)) await socket.leave(room);
      }
      for (const room of want) {
        if (!socket.rooms.has(room)) await socket.join(room);
      }
    }
  }

  /**
   * #2164: puts each CUSTOMER-role socket in exactly its own customer's room, or disconnects it.
   * A socket stays only while its user is an ACTIVE, undeleted CUSTOMER and that user's customer
   * is undeleted, inside the token's own tenant, at a seller that is not blocked. One user read
   * and one customer read per batch, however many sockets; both finish before any socket is
   * touched, so a failed read changes nothing (the resync keeps the last verified state, and a
   * new connection is refused).
   */
  private async syncCustomerRooms(sockets: RoomMember[]): Promise<void> {
    // Opus fold: a socket with no user id can never be re-checked, so it is refused, never kept.
    for (const socket of sockets) if (!socket.data.customerUserId) socket.disconnect(true);
    const userIds = [
      ...new Set(sockets.map((s) => s.data.customerUserId).filter((id): id is string => !!id)),
    ];
    if (userIds.length === 0) return;

    const liveUsers = new Map<string, string | null>(); // user id -> the user's own tenant
    const customerOf = new Map<string, { id: string; tenantId: string | null }>(); // by user id
    for (let i = 0; i < userIds.length; i += BUYER_RESYNC_BATCH) {
      const batch = userIds.slice(i, i + BUYER_RESYNC_BATCH);
      const users = await this.prisma.user.findMany({
        where: { id: { in: batch }, role: UserRole.CUSTOMER, status: "ACTIVE", deletedAt: null },
        select: { id: true, tenantId: true },
      });
      for (const user of users) liveUsers.set(user.id, user.tenantId);
      const customers = await this.prisma.customer.findMany({
        where: {
          userId: { in: batch },
          deletedAt: null,
          tenant: { status: { notIn: [...BLOCKED_SELLER_STATUSES] } },
        },
        select: { id: true, userId: true, tenantId: true },
      });
      for (const customer of customers) {
        if (customer.userId) customerOf.set(customer.userId, customer);
      }
    }

    for (const socket of sockets) {
      const userId = socket.data.customerUserId ?? "";
      const tenantId = socket.data.customerTenantId ?? null;
      const customer = customerOf.get(userId);
      const live =
        !!tenantId &&
        liveUsers.has(userId) &&
        liveUsers.get(userId) === tenantId &&
        !!customer &&
        customer.tenantId === tenantId;
      if (!live) {
        socket.disconnect(true);
        continue;
      }
      const want = this.customerRoom(tenantId, customer.id);
      for (const room of [...socket.rooms]) {
        if (room !== socket.id && room !== want) await socket.leave(room);
      }
      if (!socket.rooms.has(want)) await socket.join(want);
    }
  }

  /**
   * #1534 / SA-515: keeps each staff socket only while its user is ACTIVE and undeleted and still
   * has the role, tenant and canActAsDriver its token was minted with — a role change (including a
   * canActAsDriver toggle, when the token carries that claim) or a tenant move ends the socket, and
   * the client re-authenticates. One
   * user read per batch, however many sockets; it finishes before any socket is touched, so a
   * failed read throws and changes nothing. Returns, in order, whether each socket was kept.
   */
  private async checkStaffSockets(sockets: RoomMember[]): Promise<boolean[]> {
    const userIds = [
      ...new Set(sockets.map((s) => s.data.staffUserId).filter((id): id is string => !!id)),
    ];
    const users = new Map<
      string,
      { role: string; tenantId: string | null; canActAsDriver: boolean }
    >();
    for (let i = 0; i < userIds.length; i += BUYER_RESYNC_BATCH) {
      const rows = await this.prisma.user.findMany({
        where: {
          id: { in: userIds.slice(i, i + BUYER_RESYNC_BATCH) },
          status: "ACTIVE",
          deletedAt: null,
        },
        select: { id: true, role: true, tenantId: true, canActAsDriver: true },
      });
      for (const row of rows) users.set(row.id, row);
    }
    return sockets.map((socket) => {
      const { staffUserId, staffRole, staffTenantId, staffCanActAsDriver } = socket.data;
      const row = staffUserId ? users.get(staffUserId) : undefined;
      const live =
        !!row &&
        row.role === staffRole &&
        (row.tenantId ?? null) === (staffTenantId ?? null) &&
        (staffCanActAsDriver === undefined || row.canActAsDriver === staffCanActAsDriver);
      if (!live) socket.disconnect(true);
      return live;
    });
  }

  // ─── Client → Server events ───────────────────────────────��──────────────────

  @SubscribeMessage("driver.location.update")
  handleDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: DriverLocationPayload,
  ) {
    const user: JwtPayload | undefined = client.data.user;
    if (!user || user.role !== UserRole.DRIVER) return;

    const tenantId = user.tenantId ?? null;
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("driver.location.updated", {
      driverId: user.sub,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Server → Client emitters (called from services) ─────────────────────────

  /**
   * Operators only. A buyer learns of its own delivery through `order.statusChanged`, and of the
   * run moving through `route.progress` — never through another customer's stop.
   */
  emitStopCompleted(tenantId: string | null, payload: StopCompletedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("route.stop.completed", payload);
  }

  /**
   * #2095: tells the customers on a run that it moved. Each named customer room gets `{ runId }`
   * and nothing else; the payload is rebuilt here so an extra field a caller passes can never
   * leak. One `to([...rooms])` call, so a socket in several of the rooms receives it once.
   * Operators are not addressed: they get `route.stop.completed` / `driver.status.updated`.
   */
  emitRouteProgress(tenantId: string | null, customerIds: string[], payload: RouteProgressPayload) {
    const rooms = [...new Set(customerIds)].map((id) => this.customerRoom(tenantId, id));
    if (rooms.length === 0) return;
    this.server.to(rooms).emit("route.progress", { runId: payload.runId });
  }

  emitUrgentOrder(tenantId: string | null, payload: UrgentOrderPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("order.urgent.placed", payload);
  }

  emitDriverStatusUpdated(tenantId: string | null, payload: DriverStatusPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("driver.status.updated", payload);
  }

  /** Catalog write — operators' product caches (scan, picker, list) are stale. */
  emitProductUpdated(tenantId: string | null, payload: ProductUpdatedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("product.updated", payload);
  }

  emitOrderCreated(tenantId: string | null, payload: OrderCreatedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("order.created", payload);
  }

  emitOrderStatusChanged(tenantId: string | null, payload: OrderStatusChangedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("order.statusChanged", payload);
    this.server
      .to(this.customerRoom(tenantId, payload.customerId))
      .emit("order.statusChanged", payload);
  }

  emitReturnCreated(tenantId: string | null, payload: ReturnCreatedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("return.created", payload);
  }

  /**
   * `customerRoom: false` keeps the event on the operators' feed only, for a caller whose payload
   * status no longer says the invoice was a DRAFT (#2142 W1: `deleteInvoice` sends "DELETED").
   */
  emitInvoiceUpdated(
    tenantId: string | null,
    payload: InvoiceUpdatedPayload,
    opts: { customerRoom?: boolean } = {},
  ) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("invoice.updated", payload);
    // #2142 N1: a DRAFT is the seller's unissued working copy. The buyer invoice detail refuses
    // one (BuyerController.getInvoice), so its number and total never reach the customer's room.
    if (payload.status === InvoiceStatus.DRAFT || opts.customerRoom === false) return;
    this.server
      .to(this.customerRoom(tenantId, payload.customerId))
      .emit("invoice.updated", payload);
  }

  emitCreditNoteCreated(tenantId: string | null, payload: CreditNoteCreatedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("creditNote.created", payload);
    this.server
      .to(this.customerRoom(tenantId, payload.customerId))
      .emit("creditNote.created", payload);
  }

  /** B343: mirrors emitCreditNoteCreated — a void is exactly as visible-elsewhere as a create. */
  emitCreditNoteVoided(tenantId: string | null, payload: CreditNoteVoidedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("creditNote.voided", payload);
    this.server
      .to(this.customerRoom(tenantId, payload.customerId))
      .emit("creditNote.voided", payload);
  }

  /** RF-015: Notify a specific driver that a run has been dispatched to them. */
  emitToDriver(tenantId: string | null, driverId: string, payload: RouteDispatchedPayload) {
    this.server
      .to(this.tenantRoom(tenantId, `driver:${driverId}`))
      .emit("route.dispatched", payload);
  }

  /** A buyer's sign-in email didn't match the customer record — needs seller review. */
  emitBuyerConnectRequest(tenantId: string | null, payload: BuyerConnectRequestPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("buyer.connect.requested", payload);
  }

  /** Informational: a buyer connected directly (sign-in email matched). */
  emitBuyerAutoLinked(tenantId: string | null, payload: BuyerAutoLinkedPayload) {
    this.server
      .to(this.tenantRoom(tenantId, "operators"))
      .emit("buyer.connect.autolinked", payload);
  }

  /** A buyer declared a cash payment (or a card payment settled) — seller attention. */
  emitBuyerPaymentRequest(tenantId: string | null, payload: BuyerPaymentRequestPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("buyer.payment.requested", payload);
  }

  /** A GoHighLevel lead was created/linked into a RouteFlow customer (spec R24). */
  emitCrmHandoff(tenantId: string | null, payload: CrmHandoffPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("crm.lead.handoff", payload);
  }
}
