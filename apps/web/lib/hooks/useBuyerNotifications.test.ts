/**
 * B104 / #2095 — the buyer portal's socket hook, now that buyer sockets actually join rooms.
 *
 * - An order.statusChanged push refreshes the order detail AND its "Track your delivery" card
 *   (keyed under the order), the order list, the dashboard and the active draft.
 * - The server joins a buyer socket to every seller it is linked to, so the notification list
 *   (this portal's) only takes events for the seller on screen; caches refresh either way.
 * - Every reconnect presents the current token (a getter, not a captured string).
 * - Leaving the portal closes the socket.
 * - #2142 N2/W2: the bell persists per buyer account and seller, never in a shared slot.
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

function activeSeller(customerId: string, tenantId = "t-1") {
  localStorage.setItem(
    BUYER_KEYS.activeSeller,
    JSON.stringify({
      linkId: "l-1",
      linkStatus: "ACTIVE",
      tenant: {
        id: tenantId,
        slug: tenantId === "t-1" ? "acme" : "globex",
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

// ─── #2142 N2: one bell per buyer account ───────────────────────────────────────

/** A buyer access token as the client reads it (payload only; no signature check). */
function buyerJwt(sub: string) {
  const part = (o: object) => btoa(JSON.stringify(o));
  return [
    part({ alg: "HS256", typ: "JWT" }),
    part({ sub, email: `${sub}@example.test`, name: sub, type: "BUYER", exp: 4102444800 }),
    "sig",
  ].join(".");
}

const stored = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null");
const bellKeys = () =>
  Object.keys(localStorage).filter((k) => k.startsWith("rf_buyer_notifications"));
const oldNotice = {
  id: "n-old",
  type: "invoice",
  title: "Invoice updated",
  description: "Invoice INV-OLD has been updated",
  timestamp: 1,
  read: false,
};

describe("useBuyerNotifications — the bell belongs to one buyer (#2142 N2)", () => {
  it("#2142 N2: persists under the signed-in buyer's own key, never the shared one", async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt("buyer-a"));
    await mounted();
    act(() => {
      fakeSocket.emit("order.statusChanged", {
        orderId: "ord-9",
        customerId: "c-mine",
        orderNumber: "ORD-9",
        status: "DELIVERED",
      });
    });
    expect(stored("rf_buyer_notifications:buyer-a:t-1")).toEqual([
      expect.objectContaining({ type: "order", title: "Order Delivered" }),
    ]);
    expect(bellKeys()).toEqual(["rf_buyer_notifications:buyer-a:t-1"]);
  });

  it("#2142 N2: the next buyer on the same browser starts with an empty bell", async () => {
    localStorage.setItem("rf_buyer_notifications:buyer-a:t-1", JSON.stringify([oldNotice]));
    // The pre-#2142 shared slot: it may be anyone's, so it is never read.
    localStorage.setItem("rf_buyer_notifications", JSON.stringify([oldNotice]));
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt("buyer-b"));

    const { result } = await mounted();
    expect(result.current.notifications).toEqual([]);
  });

  it("a returning buyer gets its own bell back", async () => {
    localStorage.setItem("rf_buyer_notifications:buyer-a:t-1", JSON.stringify([oldNotice]));
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt("buyer-a"));

    const { result } = await mounted();
    await waitFor(() => expect(result.current.notifications).toEqual([oldNotice]));
  });

  it("with no identifiable buyer the bell works in memory and persists nothing", async () => {
    // beforeEach's "tok-1" is not a JWT: no buyer id can be read from it.
    const { result } = await mounted();
    act(() => {
      fakeSocket.emit("order.statusChanged", {
        orderId: "ord-9",
        customerId: "c-mine",
        orderNumber: "ORD-9",
        status: "DELIVERED",
      });
    });
    expect(result.current.notifications).toHaveLength(1);
    expect(bellKeys()).toEqual([]);
  });
});

describe("useBuyerNotifications — the bell belongs to one seller too (#2142 W2)", () => {
  function mountAt(tenantId: string) {
    return renderHook(({ t }: { t: string }) => useBuyerNotifications(t), {
      wrapper: Wrapper,
      initialProps: { t: tenantId },
    });
  }

  it("#2142 W2: switching from seller A to seller B shows B's bell, never A's notices", async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt("buyer-a"));
    localStorage.setItem("rf_buyer_notifications:buyer-a:t-1", JSON.stringify([oldNotice]));

    const hook = mountAt("t-1");
    await waitFor(() => expect(hook.result.current.notifications).toEqual([oldNotice]));

    // The buyer switches to seller B (or lands there after A revoked the link).
    activeSeller("c-mine-at-b", "t-2");
    hook.rerender({ t: "t-2" });
    await waitFor(() => expect(hook.result.current.notifications).toEqual([]));

    await waitFor(() => expect(fakeSocket.hasListener("order.statusChanged")).toBe(true));
    act(() => {
      fakeSocket.emit("order.statusChanged", {
        orderId: "ord-b",
        customerId: "c-mine-at-b",
        orderNumber: "ORD-B",
        status: "DELIVERED",
      });
    });
    // B's notice lands in B's slot; A's slot is untouched.
    expect(stored("rf_buyer_notifications:buyer-a:t-2")).toEqual([
      expect.objectContaining({ description: "Order #ORD-B status changed to Delivered" }),
    ]);
    expect(stored("rf_buyer_notifications:buyer-a:t-1")).toEqual([oldNotice]);

    // And back to A: A's own list again, without B's notice.
    activeSeller("c-mine", "t-1");
    hook.rerender({ t: "t-1" });
    await waitFor(() => expect(hook.result.current.notifications).toEqual([oldNotice]));
  });

  it("#2173 N1: the first render after a seller switch already shows only the new seller's notices", async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt("buyer-a"));
    const bNotice = { ...oldNotice, id: "n-b", description: "Invoice INV-B has been updated" };
    localStorage.setItem("rf_buyer_notifications:buyer-a:t-1", JSON.stringify([oldNotice]));
    localStorage.setItem("rf_buyer_notifications:buyer-a:t-2", JSON.stringify([bNotice]));

    // Record what EVERY render returns — rerender() flushes effects inside act, so reading
    // result.current afterwards would hide a stale frame the user actually sees painted.
    const seen: { t: string; ids: string[] }[] = [];
    const hook = renderHook(
      ({ t }: { t: string }) => {
        const r = useBuyerNotifications(t);
        seen.push({ t, ids: r.notifications.map((n) => n.id) });
        return r;
      },
      { wrapper: Wrapper, initialProps: { t: "t-1" } },
    );
    await waitFor(() => expect(hook.result.current.notifications).toEqual([oldNotice]));

    activeSeller("c-mine-at-b", "t-2");
    hook.rerender({ t: "t-2" });
    const afterSwitch = seen.filter((s) => s.t === "t-2");
    expect(afterSwitch.length).toBeGreaterThan(0);
    for (const frame of afterSwitch) expect(frame.ids).toEqual(["n-b"]);
  });

  it("#2173 N2: an event that arrives after the switch, before the bell re-renders, is saved under the NEW seller", async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt("buyer-a"));
    localStorage.setItem("rf_buyer_notifications:buyer-a:t-1", JSON.stringify([oldNotice]));
    const hook = mountAt("t-1");
    await waitFor(() => expect(hook.result.current.notifications).toEqual([oldNotice]));
    await waitFor(() => expect(fakeSocket.hasListener("order.statusChanged")).toBe(true));

    // The stored active seller is already B (the filter reads it), but the portal has not yet
    // re-rendered the bell with B's tenant id.
    activeSeller("c-mine-at-b", "t-2");
    act(() => {
      fakeSocket.emit("order.statusChanged", {
        orderId: "ord-b",
        customerId: "c-mine-at-b",
        orderNumber: "ORD-B",
        status: "DELIVERED",
      });
    });

    expect(stored("rf_buyer_notifications:buyer-a:t-1")).toEqual([oldNotice]); // A untouched
    expect(stored("rf_buyer_notifications:buyer-a:t-2")).toEqual([
      expect.objectContaining({ description: "Order #ORD-B status changed to Delivered" }),
    ]);
    expect(hook.result.current.notifications).toEqual([oldNotice]); // A's list on screen, unchanged
  });

  it("with no active seller the bell persists nothing", async () => {
    localStorage.setItem(BUYER_KEYS.accessToken, buyerJwt("buyer-a"));
    localStorage.setItem("rf_buyer_notifications:buyer-a:t-1", JSON.stringify([oldNotice]));
    const hook = renderHook(() => useBuyerNotifications(null), { wrapper: Wrapper });
    await waitFor(() => expect(fakeSocket.hasListener("order.statusChanged")).toBe(true));
    expect(hook.result.current.notifications).toEqual([]);
  });
});
