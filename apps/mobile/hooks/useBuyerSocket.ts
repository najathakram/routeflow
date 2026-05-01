import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { useBuyerSessionStore } from "../lib/buyer-session-store";

const SOCKET_URL =
  (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

/**
 * RF-002: Real-time updates for the buyer/customer surface.
 *
 * Connects with the buyer-namespaced JWT (`buyerAccessToken`) and invalidates
 * buyer-scoped query keys when relevant events arrive — so order status,
 * invoices, and the dashboard reflect operator-side changes without the
 * buyer pulling-to-refresh. Mirrors `useSocket` on the operator/driver side.
 */
export function useBuyerSocket() {
  const qc = useQueryClient();
  const { buyer } = useBuyerSessionStore();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!buyer) return;

    let mounted = true;

    const connect = async () => {
      let token: string | null = null;
      if (Platform.OS === "web") {
        token = localStorage.getItem("buyerAccessToken");
      } else {
        const { getItemAsync } = await import("expo-secure-store");
        token = await getItemAsync("buyerAccessToken");
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

      socket.on("order.statusChanged", () => {
        void qc.invalidateQueries({ queryKey: ["buyer-orders"] });
        void qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
      });

      socket.on("invoice.updated", () => {
        void qc.invalidateQueries({ queryKey: ["buyer-invoices"] });
        void qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
      });

      socket.on("inventory.low.stock", () => {
        void qc.invalidateQueries({ queryKey: ["buyer-products"] });
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
  }, [buyer, qc]);
}
