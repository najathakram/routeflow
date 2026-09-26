/**
 * `connectSocket` hands socket.io either a fixed token (staff callers, unchanged) or a getter
 * that socket.io asks on every (re)connect attempt (the buyer portal, #2095 / B104), so a socket
 * that drops after its first token expired reconnects on the current one.
 */
const mockIo = jest.fn();
jest.mock("socket.io-client", () => ({
  io: (...args: unknown[]) => mockIo(...args),
}));

import { connectSocket, disconnectSocket } from "./socket";

function fakeSocket() {
  return { connected: false, active: false, disconnect: jest.fn(), removeAllListeners: jest.fn() };
}

beforeEach(() => {
  mockIo.mockReset();
  mockIo.mockImplementation(() => fakeSocket());
  disconnectSocket();
});

it("a fixed token is sent as-is", () => {
  connectSocket("tok-staff");
  expect(mockIo.mock.calls[0][1].auth).toEqual({ token: "tok-staff" });
});

it("a getter is asked on every connect attempt, so each one carries the current token", () => {
  let current: string | null = "tok-1";
  connectSocket(() => current);
  const auth = mockIo.mock.calls[0][1].auth as (cb: (data: { token: string }) => void) => void;
  expect(typeof auth).toBe("function");

  const sent: Array<{ token: string }> = [];
  auth((data) => sent.push(data));
  current = "tok-2";
  auth((data) => sent.push(data));
  current = null;
  auth((data) => sent.push(data));

  expect(sent).toEqual([{ token: "tok-1" }, { token: "tok-2" }, { token: "" }]);
});
