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
import { UserRole } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BLOCKED_SELLER_STATUSES, liveBuyerLinkWhere } from "../buyer/buyer-link-scope";

/**
 * B104: how often every connected buyer socket's rooms are re-derived from its links, so a link
 * revoked (or granted) while a portal tab stays open takes effect within this bound. The HTTP
 * guard re-checks on every request; a socket cannot, so this is the socket's equivalent.
 */
export const BUYER_ROOM_RESYNC_MS = 60_000;

/** `buyerAccountId: { in }` batch size for the resync read (well under Postgres' bind limit). */
const BUYER_RESYNC_BATCH = 500;

/** The server-side sockets the buyer-room sync reads and moves (this node's own sockets). */
interface RoomMember {
  id: string;
  rooms: Set<string>;
  data: { buyerAccountId?: string };
  join(room: string): unknown;
  leave(room: string): unknown;
}

// ─── Typed event payloads ──────────────────────────────────────────────────────

export interface StopCompletedPayload {
  runId: string;
  stopId: string;
  customerId: string;
  orderId?: string;
  completedAt: string;
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

export interface LowStockPayload {
  productId: string;
  productName: string;
  sku: string;
  stockLevel: number;
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
        (client.data as RoomMember["data"]).buyerAccountId = payload.sub;
        await this.syncBuyerRooms([client]);
        return;
      }

      client.data.user = payload;

      const tenantId = payload.tenantId ?? null;

      if (payload.role === UserRole.OPERATOR || payload.role === UserRole.TENANT_ADMIN) {
        await client.join(this.tenantRoom(tenantId, "operators"));
      } else if (payload.role === UserRole.DRIVER) {
        await client.join(this.tenantRoom(tenantId, `driver:${payload.sub}`));
      } else if (payload.role === UserRole.CUSTOMER) {
        // B104: the room the emitters address is keyed by the Customer, resolved from the user
        // inside the token's own tenant (a removed customer resolves nothing, REG-B131).
        const customer = tenantId
          ? await this.prisma.customer.findFirst({
              where: { userId: payload.sub, tenantId, deletedAt: null },
              select: { id: true },
            })
          : null;
        if (customer) await client.join(this.customerRoom(tenantId, customer.id));
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
   */
  async resyncBuyerRooms(): Promise<void> {
    if (!this.server) return;
    try {
      const sockets = (await this.server.local.fetchSockets()) as unknown as RoomMember[];
      await this.syncBuyerRooms(sockets.filter((s) => !!s.data?.buyerAccountId));
    } catch (err) {
      this.logger.warn(`[B104] buyer room resync skipped: ${(err as Error)?.message ?? err}`);
    }
  }

  /**
   * Puts each buyer socket in exactly the customer rooms its account's live links grant (the
   * portal guard's own rule, `liveBuyerLinkWhere`, at a seller that is not blocked) and takes it
   * out of every other room. One read per batch of accounts, however many sockets they hold.
   */
  private async syncBuyerRooms(sockets: RoomMember[]): Promise<void> {
    const accountIds = [
      ...new Set(sockets.map((s) => s.data.buyerAccountId).filter((id): id is string => !!id)),
    ];
    if (accountIds.length === 0) return;

    const granted = new Map<string, Set<string>>();
    for (let i = 0; i < accountIds.length; i += BUYER_RESYNC_BATCH) {
      const links = await this.prisma.customerLink.findMany({
        where: {
          ...liveBuyerLinkWhere({ in: accountIds.slice(i, i + BUYER_RESYNC_BATCH) }),
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
      const want = granted.get(socket.data.buyerAccountId ?? "") ?? new Set<string>();
      for (const room of [...socket.rooms]) {
        if (room !== socket.id && !want.has(room)) await socket.leave(room);
      }
      for (const room of want) {
        if (!socket.rooms.has(room)) await socket.join(room);
      }
    }
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

  emitStopCompleted(tenantId: string | null, payload: StopCompletedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("route.stop.completed", payload);
  }

  emitUrgentOrder(tenantId: string | null, payload: UrgentOrderPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("order.urgent.placed", payload);
  }

  emitDriverStatusUpdated(tenantId: string | null, payload: DriverStatusPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("driver.status.updated", payload);
  }

  emitLowStock(tenantId: string | null, payload: LowStockPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("inventory.low.stock", payload);
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

  emitInvoiceUpdated(tenantId: string | null, payload: InvoiceUpdatedPayload) {
    this.server.to(this.tenantRoom(tenantId, "operators")).emit("invoice.updated", payload);
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
