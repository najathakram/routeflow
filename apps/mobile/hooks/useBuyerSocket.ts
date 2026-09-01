import { useEffect } from "react";
import { Platform } from "react-native";
import { io, type Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { useBuyerSessionStore } from "../lib/buyer-session-store";
import { BUYER_KEYS } from "../lib/auth-keys";
import { toSecureStoreKey } from "../lib/secure-key";

const SOCKET_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

// Diagnostic logging — gated so it can be disabled by setting
// EXPO_PUBLIC_DEBUG_SOCKET=false in the Railway env.
const DEBUG = (process.env.EXPO_PUBLIC_DEBUG_SOCKET ?? "true") !== "false";
function dbg(...args: unknown[]) {
  if (DEBUG) console.log("[socket:buyer]", ...args);
}
function dbgErr(...args: unknown[]) {
  if (DEBUG) console.error("[socket:buyer]", ...args);
}

/**
 * RF-002: Real-time updates for the buyer/customer surface.
 *
 * Connects with the buyer-namespaced JWT (BUYER_KEYS.accessToken = "rf:buyer:accessToken")
 * and invalidates buyer-scoped query keys when relevant events arrive — so order
 * status, invoices, and the dashboard reflect operator-side changes without the
 * buyer pulling-to-refresh. Mirrors `useSocket` on the operator/driver side.
 *
 * NEW-m2-1 / RF-077: reads from the role-namespaced key set by buyer-auth.ts,
 * not the legacy "buyerAccessToken" key that was migrated away from.
 */
export function useBuyerSocket() {
  const qc = useQueryClient();
  const { buyer } = useBuyerSessionStore();

  useEffect(() => {
    dbg("hook mount, buyer=", buyer ? buyer.id : null);

    if (!buyer) {
      dbg("no buyer in store, skipping connect");
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
    // BUG-XR1-1: per-effect closure variable instead of useRef so cleanup
    // disconnects whatever connect() assigns even if cleanup ran first.
    let localSocket: Socket | null = null;

    const connect = async () => {
      let token: string | null = null;
      if (Platform.OS === "web") {
        // NEW-m2-1 / RF-077: read from role-namespaced key
        token = localStorage.getItem(BUYER_KEYS.accessToken);
      } else {
        const { getItemAsync } = await import("expo-secure-store");
        token = await getItemAsync(toSecureStoreKey(BUYER_KEYS.accessToken));
      }

      dbg(`storage read key=${BUYER_KEYS.accessToken} token=${token ? "[present]" : "[null]"}`);

      if (!token) {
        dbg(`no token in storage (key=${BUYER_KEYS.accessToken}), skipping connect`);
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
      // Race-check: cleanup may have run between the await above and now.
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

      socket.on("order.statusChanged", (payload?: { orderId?: string }) => {
        void qc.invalidateQueries({ queryKey: ["buyer-orders"] });
        void qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
        if (payload?.orderId) {
          void qc.invalidateQueries({ queryKey: ["buyer-order-tracking", payload.orderId] });
        }
      });

      socket.on("invoice.updated", () => {
        void qc.invalidateQueries({ queryKey: ["buyer-invoices"] });
        void qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
        void qc.invalidateQueries({ queryKey: ["buyer-payments"] });
        void qc.invalidateQueries({ queryKey: ["buyer-statement"] });
      });

      socket.on("inventory.low.stock", () => {
        void qc.invalidateQueries({ queryKey: ["buyer-products"] });
      });

      socket.on("creditNote.created", () => {
        void qc.invalidateQueries({ queryKey: ["buyer-credit-notes"] });
        void qc.invalidateQueries({ queryKey: ["buyer-dashboard"] });
        void qc.invalidateQueries({ queryKey: ["buyer-statement"] });
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
  }, [buyer, qc]);
}
