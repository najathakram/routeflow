import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  WsException,
} from "@nestjs/websockets";
import { UseGuards } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Server, Socket } from "socket.io";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { UserRole } from "@prisma/client";

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
export class RouteFlowGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly jwtService: JwtService) {}

  // ─── Connection auth ─────────────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string)?.replace("Bearer ", "");

      if (!token) throw new WsException("No token");

      const payload = this.jwtService.verify<JwtPayload>(token);
      client.data.user = payload;

      if (payload.role === UserRole.OPERATOR) {
        await client.join("operators");
      } else if (payload.role === UserRole.DRIVER) {
        await client.join(`driver:${payload.sub}`);
      } else if (payload.role === UserRole.CUSTOMER) {
        await client.join(`customer:${payload.sub}`);
      }
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket) {
    // cleanup handled automatically by socket.io
  }

  // ─── Client → Server events ──────────────────────────────────────────────────

  @SubscribeMessage("driver.location.update")
  handleDriverLocation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: DriverLocationPayload,
  ) {
    const user: JwtPayload | undefined = client.data.user;
    if (!user || user.role !== UserRole.DRIVER) return;

    this.server.to("operators").emit("driver.location.updated", {
      driverId: user.sub,
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Server → Client emitters (called from services) ─────────────────────────

  emitStopCompleted(payload: StopCompletedPayload) {
    this.server.to("operators").emit("route.stop.completed", payload);
  }

  emitUrgentOrder(payload: UrgentOrderPayload) {
    this.server.to("operators").emit("order.urgent.placed", payload);
  }

  emitDriverStatusUpdated(payload: DriverStatusPayload) {
    this.server.to("operators").emit("driver.status.updated", payload);
  }

  emitLowStock(payload: LowStockPayload) {
    this.server.to("operators").emit("inventory.low.stock", payload);
  }

  emitOrderCreated(payload: OrderCreatedPayload) {
    this.server.to("operators").emit("order.created", payload);
  }

  emitOrderStatusChanged(payload: OrderStatusChangedPayload) {
    this.server.to("operators").emit("order.statusChanged", payload);
    this.server.to(`customer:${payload.customerId}`).emit("order.statusChanged", payload);
  }

  emitReturnCreated(payload: ReturnCreatedPayload) {
    this.server.to("operators").emit("return.created", payload);
  }

  emitInvoiceUpdated(payload: InvoiceUpdatedPayload) {
    this.server.to("operators").emit("invoice.updated", payload);
    this.server.to(`customer:${payload.customerId}`).emit("invoice.updated", payload);
  }

  emitCreditNoteCreated(payload: CreditNoteCreatedPayload) {
    this.server.to("operators").emit("creditNote.created", payload);
    this.server.to(`customer:${payload.customerId}`).emit("creditNote.created", payload);
  }
}
