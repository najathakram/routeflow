import { useEffect } from "react";
import { Platform } from "react-native";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "../lib/auth-store";
import { OP_KEYS, DRIVER_KEYS } from "../lib/auth-keys";

const SOCKET_URL =
  (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

// Diagnostic logging — gated so it can be disabled by setting
// EXPO_PUBLIC_DEBUG_SOCKET=false in the Railway env.
const DEBUG = (process.env.EXPO_PUBLIC_DEBUG_SOCKET ?? "true") !== "false";
function dbg(...args: unknown[]) {
  if (DEBUG) console.log("[socket]", ...args);
}
function dbgErr(...args: unknown[]) {
  if (DEBUG) console.error("[socket]", ...args);
}

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

  useEffect(() => {
    const role = user?.role ?? "(none)";
    dbg("hook mount, role=", role, "user=", user ? user.id : null);

    if (!user) {
      dbg("no user in store, skipping connect");
      return;
    }

    // SSR guard: localStorage is only available in a real browser context.
    // Expo web can pre-render components on the server where window and
    // localStorage are absent. We check via globalThis so the guard is
    // testable in a Node.js environment (jest sets global.window and
    // global.localStorage as side-effects of the test helpers).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (Platform.OS === "web" && (g.window == null || g.localStorage == null)) {
      dbg("SSR context (no window/localStorage), skipping connect");
      return;
    }

    let mounted = true;
    // BUG-XR1-1: capture the socket in this effect's closure, not in a
    // useRef. The useRef approach leaked sockets when cleanup ran before
    // connect()'s async storage read finished — the cleanup saw socketRef
    // still null, then connect() created and assigned a socket that nobody
    // ever disconnected. With a per-effect local variable the cleanup
    // closure can disconnect whatever connect() assigns.
    let localSocket: Socket | null = null;

    const connect = async () => {
      let token: string | null = null;
      const isDriver = user.role === "DRIVER";
      const tokenKey = isDriver ? DRIVER_KEYS.accessToken : OP_KEYS.accessToken;

      if (Platform.OS === "web") {
        token = localStorage.getItem(tokenKey);
      } else {
        const { getItemAsync } = await import("expo-secure-store");
        token = await getItemAsync(tokenKey);
      }

      dbg(`storage read key=${tokenKey} token=${token ? "[present]" : "[null]"}`);

      if (!token) {
        dbg(`no token in storage (key=${tokenKey}), skipping connect`);
        return;
      }
      if (!mounted) {
        dbg("unmounted before io() — aborting");
        return;
      }

      dbg(`calling io(${SOCKET_URL})`);

      const socket = io(SOCKET_URL, {
        auth: { token },
        // Start with polling so the HTTP handshake always works through Railway's
        // proxy (polling is confirmed working). socket.io-client will upgrade to
        // WebSocket automatically after the handshake succeeds.
        transports: ["polling", "websocket"],
        reconnection: true,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 30_000,
        reconnectionAttempts: Infinity,
      });

      // Race-check: cleanup may have run between the await above and now;
      // disconnect immediately and abandon if so.
      if (!mounted) {
        dbg("unmounted during io() handshake — disconnecting");
        socket.disconnect();
        return;
      }
      localSocket = socket;

      socket.on("connect", () => {
        dbg("connected", socket.id);
      });

      socket.on("connect_error", (e: Error) => {
        dbgErr("connect_error", e?.message, e);
      });

      socket.on("disconnect", (reason: string) => {
        dbg("disconnect", reason);
      });

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
      if (localSocket) {
        localSocket.disconnect();
        localSocket = null;
      }
    };
  }, [user, qc]);
}
