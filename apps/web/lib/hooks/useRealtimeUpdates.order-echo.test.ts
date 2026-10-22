/**
 * Row 604 F17: the tab that created an order must not also get the realtime "New order placed" toast for it.
 * Fails on today's code: the handler toasts for every order.created, including this tab's own.
 */
import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRealtimeUpdates } from "./useRealtimeUpdates";
import { markOrderCreatedHere } from "../order-created-echo";
import { OP_KEYS } from "../auth-keys";

type Handler = (...args: unknown[]) => void;
const handlers = new Map<string, Handler[]>();
const fakeSocket = {
  on: (e: string, h: Handler) => handlers.set(e, [...(handlers.get(e) ?? []), h]),
  off: jest.fn(),
  emit: (e: string, ...a: unknown[]) => (handlers.get(e) ?? []).forEach((h) => h(...a)),
};
jest.mock("../socket", () => ({ connectSocket: () => fakeSocket, disconnectSocket: () => {} }));
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({ useToast: () => ({ toast: mockToast }) }));

function mount() {
  const client = new QueryClient();
  return renderHook(() => useRealtimeUpdates(), {
    wrapper: ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client }, children),
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  handlers.clear();
  mockToast.mockClear();
  localStorage.setItem(OP_KEYS.accessToken, "tok");
});
afterEach(() => jest.useRealTimers());

describe("order.created realtime toast (F17)", () => {
  it("is skipped for an order this tab just created", () => {
    mount();
    markOrderCreatedHere("ORD-1");
    fakeSocket.emit("order.created", { orderNumber: "ORD-1", customerName: "Acme", urgent: false });
    jest.advanceTimersByTime(5000);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("still toasts for someone else's order", () => {
    mount();
    markOrderCreatedHere("ORD-1");
    fakeSocket.emit("order.created", { orderNumber: "ORD-2", customerName: "Acme", urgent: false });
    jest.advanceTimersByTime(5000);
    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0][0].title).toBe("New order placed");
  });

  it("an echo that lands before the create response is still skipped", () => {
    mount();
    fakeSocket.emit("order.created", { orderNumber: "ORD-3", customerName: "Acme", urgent: false });
    markOrderCreatedHere("ORD-3");
    jest.advanceTimersByTime(5000);
    expect(mockToast).not.toHaveBeenCalled();
  });
});
