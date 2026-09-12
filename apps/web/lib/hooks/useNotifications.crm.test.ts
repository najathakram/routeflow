/**
 * TP7 (T49) — `useNotifications` gains a "crm" handler wired to the
 * `crm.lead.handoff` socket event. See test-plan.md T49 / spec R30 for the
 * exact notification shape ("New customer from GoHighLevel", href pinned
 * verbatim).
 *
 * Fails today because the skeleton `useNotifications` never registers a
 * `crm.lead.handoff` listener — the mocked socket's `on` is never called
 * with that event name, so firing it does nothing.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { useNotifications } from "./useNotifications";
import { OP_KEYS } from "../auth-keys";

// A minimal fake socket: records `on`/`off` registrations by event name and
// exposes `emit` so the test can fire an event exactly the way socket.io would.
type Handler = (...args: unknown[]) => void;

function createFakeSocket() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      handlers.set(
        event,
        list.filter((h) => h !== handler),
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

jest.mock("../socket", () => ({
  connectSocket: () => fakeSocket,
}));

jest.mock("@/components/tenant-provider", () => ({
  useTenant: () => ({ slug: "test" }),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OP_KEYS.accessToken, "tok");
});

describe("useNotifications — crm.lead.handoff (T49, R30)", () => {
  it("T49: pushes a crm notification with the pinned title and href when crm.lead.handoff fires", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: Wrapper });

    // The hook's socket effect must register a handler for this event before
    // firing it can prove anything.
    await waitFor(() => expect(fakeSocket.hasListener("crm.lead.handoff")).toBe(true));

    fakeSocket.emit("crm.lead.handoff", { customerId: "c1", customerName: "Acme" });

    await waitFor(() =>
      expect(
        result.current.notifications.some(
          (n) =>
            n.type === "crm" &&
            n.title === "New customer from GoHighLevel" &&
            (n as unknown as { href?: string }).href === "/customers/c1",
        ),
      ).toBe(true),
    );
  });
});
