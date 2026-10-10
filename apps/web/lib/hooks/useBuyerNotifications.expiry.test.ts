/**
 * #2167 end to end through the real `connectSocket`: the buyer portal's socket is kicked by the
 * server when its access token expires (#2142 R1). Only socket.io and the refresh call are
 * mocked.
 *   - expiry → the buyer refresh flow runs → the socket reconnects on the fresh token;
 *   - refresh fails → the hook reports `sessionExpired` and nothing reconnects.
 * Fixtures are placeholders.
 */
import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { BUYER_KEYS } from "../auth-keys";

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
    connected: true,
    active: true,
    connect: jest.fn(),
    disconnect: jest.fn(() => {
      s.connected = false;
      s.active = false;
    }),
    removeAllListeners: jest.fn(),
    on: jest.fn((event: string, h: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), h]);
      return s;
    }),
    off: jest.fn((event: string, h: Handler) => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((x) => x !== h),
      );
      return s;
    }),
    emit(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
  };
  return s;
}
let socket: ReturnType<typeof fakeSocket>;
const mockIo = jest.fn();
jest.mock("socket.io-client", () => ({ io: (...args: unknown[]) => mockIo(...args) }));

const mockRefresh = jest.fn();
jest.mock("../buyer-auth", () => ({
  ...jest.requireActual("../buyer-auth"),
  buyerRefreshTokens: () => mockRefresh(),
}));

import { useBuyerNotifications } from "./useBuyerNotifications";
import { disconnectSocket } from "../socket";

function jwtWithExp(expSec: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "buyer-1", type: "BUYER", exp: expSec })}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);

let client: QueryClient;
function Wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  localStorage.clear();
  disconnectSocket();
  mockIo.mockReset();
  mockIo.mockImplementation(() => (socket = fakeSocket()));
  mockRefresh.mockReset();
  client = createTestQueryClient();
  // The buyer is signed in with a token that has since expired.
  localStorage.setItem(BUYER_KEYS.accessToken, jwtWithExp(nowSec() - 60));
});

it("expiry → refresh → reconnect on the fresh token; no expired state", async () => {
  const fresh = jwtWithExp(nowSec() + 3600);
  mockRefresh.mockImplementation(async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, fresh);
    return { accessToken: fresh, refreshToken: "r-2", buyer: { id: "buyer-1" } };
  });
  const { result } = renderHook(() => useBuyerNotifications("t-1"), { wrapper: Wrapper });

  act(() => {
    socket.connected = false;
    socket.emit("disconnect", "io server disconnect");
  });

  await waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(result.current.sessionExpired).toBe(false);

  // The reconnect presents the refreshed token through the auth getter.
  const auth = mockIo.mock.calls[0][1].auth as (cb: (d: { token: string }) => void) => void;
  const sent: string[] = [];
  auth((d) => sent.push(d.token));
  expect(sent).toEqual([fresh]);
});

it("expiry → refresh fails → sessionExpired, and the socket is not reconnected", async () => {
  mockRefresh.mockResolvedValue(null);
  const { result } = renderHook(() => useBuyerNotifications("t-1"), { wrapper: Wrapper });

  act(() => {
    socket.connected = false;
    socket.emit("disconnect", "io server disconnect");
  });

  await waitFor(() => expect(result.current.sessionExpired).toBe(true));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(socket.connect).not.toHaveBeenCalled();
});
