import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../lib/auth-store";

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
        token = localStorage.getItem("accessToken");
      } else {
        const { getItemAsync } = await import("expo-secure-store");
        token = await getItemAsync("accessToken");
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
