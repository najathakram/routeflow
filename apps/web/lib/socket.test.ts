/**
 * `connectSocket` hands socket.io either a fixed token (staff callers, unchanged) or a getter
 * that socket.io asks on every (re)connect attempt (the buyer portal, #2095 / B104), so a socket
 * that drops after its first token expired reconnects on the current one.
 *
 * #2167: the server ends a socket whose token expired with a server-side disconnect
 * ("io server disconnect"), after which socket.io never reconnects on its own, so live tracking
 * used to stop silently. With `recovery`, an expiry kick (or a connect_error on an expired
 * token) refreshes the token once and reconnects; a failed refresh ends in `onSessionExpired`,
 * never a loop. Fixtures are placeholders.
 */
const mockIo = jest.fn();
jest.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => mockIo(...args),
}));

import { connectSocket, disconnectSocket, isJwtExpired } from "./socket";

type Handler = (...args: unknown[]) => void;

interface FakeSock {
  connected: boolean;
  active: boolean;
  connect: jest.Mock;
  disconnect: jest.Mock;
  removeAllListeners: jest.Mock;
  on: jest.Mock;
  off: jest.Mock;
  emit(event: string, ...args: unknown[]): void;
}
function fakeSocket(): FakeSock {
  const handlers = new Map<string, Handler[]>();
  const s: FakeSock = {
    connected: false,
    active: false,
    disconnect: jest.fn(() => {
      s.connected = false;
      s.active = false;
    }),
    connect: jest.fn(),
    removeAllListeners: jest.fn(() => handlers.clear()),
    off: jest.fn(),
    on: jest.fn((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return s;
    }),
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
  return s;
}
type FakeSocket = ReturnType<typeof fakeSocket>;

/** An unsigned JWT-shaped token with the given `exp` (seconds). Only the payload is read. */
function jwtWithExp(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "buyer-1", exp: expSec })}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
/** Lets the refresh promise chain settle. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

let current: FakeSocket;
beforeEach(() => {
  mockIo.mockReset();
  mockIo.mockImplementation(() => (current = fakeSocket()));
  disconnectSocket();
});

it("a fixed token is sent as-is", () => {
  connectSocket("tok-staff");
  expect(mockIo.mock.calls[0][1].auth).toEqual({ token: "tok-staff" });
});

it("a getter is asked on every connect attempt, so each one carries the current token", () => {
  let token: string | null = "tok-1";
  connectSocket(() => token);
  const auth = mockIo.mock.calls[0][1].auth as (cb: (data: { token: string }) => void) => void;
  expect(typeof auth).toBe("function");

  const sent: Array<{ token: string }> = [];
  auth((data) => sent.push(data));
  token = "tok-2";
  auth((data) => sent.push(data));
  token = null;
  auth((data) => sent.push(data));

  expect(sent).toEqual([{ token: "tok-1" }, { token: "tok-2" }, { token: "" }]);
});

it("without recovery no listener is added (staff callers unchanged)", () => {
  connectSocket("tok-staff");
  expect(current.on).not.toHaveBeenCalled();
});

describe("isJwtExpired", () => {
  it("reads exp from the payload, with a skew margin", () => {
    expect(isJwtExpired(jwtWithExp(nowSec() - 1))).toBe(true);
    expect(isJwtExpired(jwtWithExp(nowSec() + 10))).toBe(true); // inside the 30 s skew
    expect(isJwtExpired(jwtWithExp(nowSec() + 3600))).toBe(false);
  });
  it("a missing or unreadable token counts as expired; one without exp does not", () => {
    expect(isJwtExpired(null)).toBe(true);
    expect(isJwtExpired("not-a-jwt")).toBe(true);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(isJwtExpired(`${b64({})}.${b64({ sub: "x" })}.sig`)).toBe(false);
  });
});

describe("#2167 expiry recovery", () => {
  function setup(refreshResult: boolean | (() => Promise<boolean>), initialToken: string) {
    let token: string | null = initialToken;
    const refresh = jest.fn(async () => {
      const ok = typeof refreshResult === "function" ? await refreshResult() : refreshResult;
      if (ok) token = jwtWithExp(nowSec() + 3600);
      return ok;
    });
    const onSessionExpired = jest.fn();
    const socket = connectSocket(() => token, {
      refresh,
      onSessionExpired,
    }) as unknown as FakeSocket;
    return { socket, refresh, onSessionExpired, getToken: () => token };
  }

  it("expiry kick → refresh → reconnect on the new token", async () => {
    const { socket, refresh, onSessionExpired, getToken } = setup(true, jwtWithExp(nowSec() - 5));
    socket.emit("disconnect", "io server disconnect");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(isJwtExpired(getToken())).toBe(false);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("expiry kick, refresh fails → session expired, no reconnect", async () => {
    const { socket, refresh, onSessionExpired } = setup(false, jwtWithExp(nowSec() - 5));
    socket.emit("disconnect", "io server disconnect");
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("a thrown refresh counts as a failed one", async () => {
    const { socket, onSessionExpired } = setup(
      () => Promise.reject(new Error("network")),
      jwtWithExp(nowSec() - 5),
    );
    socket.emit("disconnect", "io server disconnect");
    await flush();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("a server kick while the token is still valid is not treated as expiry", async () => {
    const { socket, refresh, onSessionExpired } = setup(true, jwtWithExp(nowSec() + 3600));
    socket.emit("disconnect", "io server disconnect");
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("a network drop is left to socket.io's own reconnection", async () => {
    const { socket, refresh } = setup(true, jwtWithExp(nowSec() - 5));
    socket.emit("disconnect", "transport close");
    await flush();
    expect(refresh).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("connect_error on an expired token refreshes; socket.io's retry then reads the new token", async () => {
    const { socket, refresh, onSessionExpired } = setup(true, jwtWithExp(nowSec() - 5));
    socket.emit("connect_error", new Error("xhr poll error"));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    // socket.io is still retrying on its own (the auth getter reads the fresh token): no manual connect.
    expect(socket.connect).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("connect_error on an expired token with a failed refresh stops retrying", async () => {
    const { socket, onSessionExpired } = setup(false, jwtWithExp(nowSec() - 5));
    socket.emit("connect_error", new Error("xhr poll error"));
    await flush();
    expect(socket.disconnect).toHaveBeenCalled();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it("a second expiry signal while a refresh is in flight shares that refresh", async () => {
    let resolve!: (ok: boolean) => void;
    const pending = new Promise<boolean>((r) => (resolve = r));
    const { socket, refresh } = setup(() => pending, jwtWithExp(nowSec() - 5));
    socket.emit("connect_error", new Error("a"));
    socket.emit("disconnect", "io server disconnect");
    resolve(true);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("repeated expiry kicks with no stable connection stop after 3 recoveries", async () => {
    // The refresh "succeeds" but the server keeps kicking (e.g. the new token is expired too).
    let token: string | null = jwtWithExp(nowSec() - 5);
    const refresh = jest.fn(async () => true);
    const onSessionExpired = jest.fn();
    const socket = connectSocket(() => token, {
      refresh,
      onSessionExpired,
    }) as unknown as FakeSocket;
    for (let i = 0; i < 5; i++) {
      socket.emit("disconnect", "io server disconnect");
      await flush();
    }
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(socket.connect).toHaveBeenCalledTimes(3);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    token = null;
  });

  it("a connection that stays up resets the recovery budget", async () => {
    jest.useFakeTimers();
    try {
      let token: string | null = null;
      const refresh = jest.fn(async () => true);
      const onSessionExpired = jest.fn();
      const socket = connectSocket(() => token, {
        refresh,
        onSessionExpired,
      }) as unknown as FakeSocket;
      // Four separate expiries, each after a connection that stayed up: one more than the cap,
      // so only the reset lets the fourth recover instead of ending the session.
      for (let round = 0; round < 4; round++) {
        token = jwtWithExp(nowSec() - 5);
        socket.emit("disconnect", "io server disconnect");
        await flush();
        socket.emit("connect");
        jest.advanceTimersByTime(30_000);
      }
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(onSessionExpired).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("a refresh that lands after disconnectSocket() never reconnects the discarded socket", async () => {
    let resolve!: (ok: boolean) => void;
    const pending = new Promise<boolean>((r) => (resolve = r));
    const { socket, onSessionExpired } = setup(() => pending, jwtWithExp(nowSec() - 5));
    socket.emit("disconnect", "io server disconnect");
    disconnectSocket();
    resolve(true);
    await flush();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});
