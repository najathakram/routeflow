import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../lib/auth-store";
import { OP_KEYS, DRIVER_KEYS } from "../lib/auth-keys";

const SOCKET_URL =
  (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

// ─── Typed event payloads (mirrors routeflow.gateway.ts) ─────────────────────

interface OrderCreatedPayload {
  orderId: string;
  orderNumber: string;
  customerName: string;
  urgent: boolean;
}

interface OrderStatusChangedPayload {
  orderId: string;
  orderNumber: string;
  customerId: string;
  status: string;
}

interface StopCompletedPayload {
  stopId: string;
  runId: string;
}

interface RouteDispatchedPayload {
  runId: string;
  routeId: string;
  routeName: string;
  scheduledDate: string;
  stopCount: number;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSocket() {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!user) return;

    let mounted = true;

    const connect = async () => {
      let token: string | null = null;
      if (Platform.OS === "web") {
        // NEW-m2-1 / RF-077: read from role-namespaced key
        const role = user.role;
        const isDriver = role === "DRIVER";
        token = localStorage.getItem(isDriver ? DRIVER_KEYS.accessToken : OP_KEYS.accessToken);
      } else {
        const { getItemAsync } = await import("expo-secure-store");
        const isDriver = user.role === "DRIVER";
        token = await getItemAsync(isDriver ? DRIVER_KEYS.accessToken : OP_KEYS.accessToken);
      }

      if (!token || !mounted) return;

      const socket = io(SOCKET_URL, {
        auth: { token },
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 30_000,
        reconnectionAttempts: Infinity,
      });

      socketRef.current = socket;

      socket.on("order.created", (_data: OrderCreatedPayload) => {
        void qc.invalidateQueries({ queryKey: ["admin", "orders"] });
        void qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
      });

      socket.on("order.urgent.placed", () => {
        void qc.invalidateQueries({ queryKey: ["admin", "orders"] });
        void qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
      });

      socket.on("order.statusChanged", (_data: OrderStatusChangedPayload) => {
        void qc.invalidateQueries({ queryKey: ["admin", "orders"] });
        void qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
      });

      // RF-015: driver receives this when operator dispatches a run to them
      socket.on("route.dispatched", (_data: RouteDispatchedPayload) => {
        void qc.invalidateQueries({ queryKey: ["route-runs"] });
        void qc.invalidateQueries({ queryKey: ["admin", "routes"] });
      });

      socket.on("route.stop.completed", (_data: StopCompletedPayload) => {
        void qc.invalidateQueries({ queryKey: ["route-runs"] });
        void qc.invalidateQueries({ queryKey: ["admin", "routes"] });
      });

      socket.on("driver.status.updated", () => {
        void qc.invalidateQueries({ queryKey: ["admin", "drivers"] });
        void qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
      });

      socket.on("inventory.low.stock", () => {
        void qc.invalidateQueries({ queryKey: ["admin", "products"] });
        void qc.invalidateQueries({ queryKey: ["admin", "dashboard"] });
      });

      socket.on("return.created", () => {
        void qc.invalidateQueries({ queryKey: ["admin", "returns"] });
      });

      socket.on("invoice.updated", () => {
        void qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      });
    };

    void connect();

    return () => {
      mounted = false;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [user, qc]);
}
