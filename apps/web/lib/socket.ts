import { io, Socket } from "socket.io-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

// Strip /api/v1 suffix — socket.io connects to the root server
const SOCKET_URL = API_URL.replace(/\/api\/v1\/?$/, "");

let socket: Socket | null = null;

/**
 * #2167: how a socket recovers when its access token expires. The server ends an expired socket
 * with a server-side disconnect ("io server disconnect", #2142 R1), and socket.io never
 * reconnects on its own after one, so without this the socket stays down silently.
 */
export interface SocketAuthRecovery {
  /** Refreshes the access token through the caller's own refresh flow. True when a fresh token
   *  is now readable through the `token` getter; false (or a throw) when the session is over. */
  refresh: () => Promise<boolean>;
  /** Called once when the refresh fails or recovery keeps failing: show the expired state. */
  onSessionExpired: () => void;
}

/** Seconds of clock skew under which a token counts as already expired. */
const EXPIRY_SKEW_SEC = 30;
/** Recoveries allowed without a connection that stays up in between; then the session ends. */
const MAX_RECOVERIES = 3;
/** A connection that lasts this long resets the recovery budget. */
const STABLE_CONNECTION_MS = 30_000;

/**
 * True when `token` is missing, unreadable, or its `exp` is within EXPIRY_SKEW_SEC of now. A token
 * with no `exp` never expires by this test. Reads the payload only; the server verifies.
 */
export function isJwtExpired(token: string | null | undefined, nowMs = Date.now()): boolean {
  if (!token) return true;
  const part = token.split(".")[1];
  if (!part) return true;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as {
      exp?: unknown;
    };
    if (typeof payload.exp !== "number") return false;
    return payload.exp - EXPIRY_SKEW_SEC <= Math.floor(nowMs / 1000);
  } catch {
    return true;
  }
}

function attachRecovery(s: Socket, readToken: () => string | null, recovery: SocketAuthRecovery) {
  let inflight: Promise<boolean> | null = null;
  let recoveries = 0;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let ended = false;

  const isCurrent = () => socket === s && !ended;
  const endSession = () => {
    if (ended) return;
    ended = true;
    recovery.onSessionExpired();
  };

  /** One shared refresh per expiry, whichever signal arrives first. */
  const refreshOnce = (): Promise<boolean> => {
    if (!inflight) {
      recoveries += 1;
      inflight = Promise.resolve()
        .then(() => recovery.refresh())
        .catch(() => false)
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  const recover = async (kind: "kicked" | "connect_error") => {
    if (!isCurrent() || !isJwtExpired(readToken())) return;
    if (!inflight && recoveries >= MAX_RECOVERIES) {
      s.disconnect();
      endSession();
      return;
    }
    const ok = await refreshOnce();
    if (!isCurrent()) return;
    if (!ok) {
      s.disconnect(); // stop socket.io's own retries on a token that can no longer work
      endSession();
      return;
    }
    // After a server kick socket.io does not retry, so reconnect by hand; the auth getter reads
    // the fresh token. On connect_error socket.io is still retrying and picks it up itself.
    if (kind === "kicked" && !s.connected) s.connect();
  };

  s.on("connect", () => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      recoveries = 0;
    }, STABLE_CONNECTION_MS);
  });
  s.on("disconnect", (reason: unknown) => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
    // Only a server-side disconnect can be an expiry kick; a network drop is socket.io's to retry.
    if (reason === "io server disconnect") void recover("kicked");
  });
  s.on("connect_error", () => {
    void recover("connect_error");
  });
}

/**
 * `token` may be a getter: socket.io then asks it on EVERY (re)connect attempt, so a socket that
 * drops after its first token expired comes back on the current one instead of being refused.
 * With `recovery` (getter only), an expired token is refreshed and the socket reconnected (#2167).
 */
export function connectSocket(
  token: string | (() => string | null),
  recovery?: SocketAuthRecovery,
): Socket {
  // Guard: return existing socket if already connected OR still connecting
  if (socket?.connected || socket?.active) return socket;

  // If a stale disconnected socket exists, clean it up first
  if (socket) {
    socket.removeAllListeners();
    socket = null;
  }

  socket = io(SOCKET_URL, {
    auth:
      typeof token === "function"
        ? (cb: (data: { token: string }) => void) => cb({ token: token() ?? "" })
        : { token },
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5,
  });

  if (recovery && typeof token === "function") attachRecovery(socket, token, recovery);

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function getSocket(): Socket | null {
  return socket;
}
