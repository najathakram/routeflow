/**
 * B104 / #2095 — the buyer portal's socket hook, now that buyer sockets actually join rooms.
 *
 * - An order.statusChanged push refreshes the order detail AND its "Track your delivery" card
 *   (keyed under the order), the order list, the dashboard and the active draft.
 * - The server joins a buyer socket to every seller it is linked to, so the notification list
 *   (this portal's) only takes events for the seller on screen; caches refresh either way.
 * - Every reconnect presents the current token (a getter, not a captured string).
 * - Leaving the portal closes the socket.
 * Fixtures are placeholders.
 */
import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { BUYER_KEYS } from "../auth-keys";
import { useBuyerNotifications } from "./useBuyerNotifications";

type Handler = (...args: unknown[]) => void;

function createFakeSocket() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off(event: string, handler: Handler) {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== handler),
      );
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    hasListener(event: string) {
      return (handlers.get(event) ?? []).length > 0;
    },
  };
}

const fakeSocket = createFakeSocket();
const mockConnect = jest.fn((_token: unknown) => fakeSocket);
const mockDisconnect = jest.fn();
jest.mock("../socket", () => ({
  connectSocket: (token: unknown) => mockConnect(token),
  disconnectSocket: () => mockDisconnect(),
}));

let client: QueryClient;
function Wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client }, children);
}

function activeSeller(customerId: string) {
  localStorage.setItem(
    BUYER_KEYS.activeSeller,
    JSON.stringify({
      linkId: "l-1",
      linkStatus: "ACTIVE",
      tenant: {
        id: "t-1",
        slug: "acme",
        name: "Acme Wholesale",
        logoKey: null,
        primaryColor: null,
      },
      customer: { id: customerId, businessName: "Sample Buyer Co", email: null },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(BUYER_KEYS.accessToken, "tok-1");
  activeSeller("c-mine");
  jest.clearAllMocks();
  client = createTestQueryClient();
});

async function mounted() {
  const hook = renderHook(() => useBuyerNotifications(), { wrapper: Wrapper });
  await waitFor(() => expect(fakeSocket.hasListener("order.statusChanged")).toBe(true));
  return hook;
}

describe("useBuyerNotifications — order.statusChanged (B104, #2095)", () => {
  it("refreshes the order (and its tracking card), the list, the dashboard and the active draft", async () => {
    const invalidate = jest.spyOn(client, "invalidateQueries");
    await mounted();

    act(() => {
      fakeSocket.emit("order.statusChanged", {
        orderId: "ord-9",
        customerId: "c-mine",
        orderNumber: "ORD-9",
        status: "DELIVERED",
        previousStatus: "CONFIRMED",
      });
    });

    // A prefix match (no `exact`): the tracking query lives at ["buyer", "order", id, "tracking"].
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["buyer", "order", "ord-9"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["buyer", "orders"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["buyer", "dashboard"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["buyer", "activeOrder"] });
  });

  it("notifies for the seller on screen", async () => {
    const { result } = await mounted();
    act(() => {
      fakeSocket.emit("order.statusChanged", {
        orderId: "ord-9",
        customerId: "c-mine",
        orderNumber: "ORD-9",
        status: "OUT_FOR_DELIVERY",
      });
    });
    expect(result.current.notifications[0]).toEqual(
      expect.objectContaining({
        type: "order",
        title: "Order Out For Delivery",
        description: "Order #ORD-9 status changed to Out For Delivery",
      }),
    );
  });

  it("another seller's event refreshes caches but does not land in this portal's list", async () => {
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = await mounted();
    act(() => {
      fakeSocket.emit("order.statusChanged", {
        orderId: "ord-elsewhere",
        customerId: "c-at-another-seller",
        orderNumber: "ORD-77",
        status: "DELIVERED",
      });
      fakeSocket.emit("invoice.updated", {
        invoiceNumber: "INV-77",
        customerId: "c-at-another-seller",
      });
      fakeSocket.emit("creditNote.created", {
        creditNoteNumber: "CN-77",
        customerId: "c-at-another-seller",
      });
    });
    expect(result.current.notifications).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["buyer", "order", "ord-elsewhere"] });
  });
});

describe("useBuyerNotifications — route.progress (#2095 follow-up)", () => {
  it("refreshes every order detail and its tracking card, silently", async () => {
    const invalidate = jest.spyOn(client, "invalidateQueries");
    const { result } = await mounted();
    expect(fakeSocket.hasListener("route.progress")).toBe(true);

    act(() => {
      fakeSocket.emit("route.progress", { runId: "run-1" });
    });

    // A prefix match: every ["buyer", "order", id] and ["buyer", "order", id, "tracking"].
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["buyer", "order"] });
    expect(result.current.notifications).toEqual([]);
  });

  it("does not subscribe to route.stop.completed (operators only; a buyer's own delivery is order.statusChanged)", async () => {
    const { result } = await mounted();
    expect(fakeSocket.hasListener("route.stop.completed")).toBe(false);

    act(() => {
      fakeSocket.emit("route.stop.completed", {
        runId: "run-1",
        stopId: "s-1",
        customerId: "c-mine",
      });
    });
    expect(result.current.notifications).toEqual([]);
  });
});

describe("useBuyerNotifications — the socket's lifetime", () => {
  it("connects with a token getter, so a reconnect presents the current token", async () => {
    await mounted();
    const token = mockConnect.mock.calls[0][0];
    expect(typeof token).toBe("function");
    expect((token as () => string | null)()).toBe("tok-1");
    localStorage.setItem(BUYER_KEYS.accessToken, "tok-2");
    expect((token as () => string | null)()).toBe("tok-2");
  });

  it("does not connect without a buyer session", () => {
    localStorage.removeItem(BUYER_KEYS.accessToken);
    renderHook(() => useBuyerNotifications(), { wrapper: Wrapper });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("leaving the portal closes the socket", async () => {
    const { unmount } = await mounted();
    unmount();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(fakeSocket.hasListener("order.statusChanged")).toBe(false);
  });
});
