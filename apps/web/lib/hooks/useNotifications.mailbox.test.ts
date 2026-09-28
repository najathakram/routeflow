/**
 * #2113 — `useNotifications` handles the TENANT_ADMIN-only `mailbox.alert` socket event (F-10a web
 * bell): the server's own copy becomes a "mailbox" entry that links to the Email settings, where
 * the mailbox is reconnected. Fake-socket harness as in useNotifications.crm.test.ts.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { useNotifications } from "./useNotifications";
import { OP_KEYS } from "../auth-keys";

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

describe("useNotifications — mailbox.alert (#2113)", () => {
  it("pushes the server's copy as an unread mailbox entry linking to Email settings", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: Wrapper });
    await waitFor(() => expect(fakeSocket.hasListener("mailbox.alert")).toBe(true));

    fakeSocket.emit("mailbox.alert", {
      status: "REVOKED",
      provider: "GOOGLE",
      title: "Your Google mailbox was disconnected",
      body: "Email is going out from RouteFlow meanwhile. Reconnect it in Settings → Email.",
    });

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0]).toMatchObject({
      type: "mailbox",
      title: "Your Google mailbox was disconnected",
      description: "Email is going out from RouteFlow meanwhile. Reconnect it in Settings → Email.",
      href: "/settings?tab=email",
      read: false,
    });
    expect(result.current.unreadCount).toBe(1);
  });

  it("an empty payload still produces a readable entry, never a blank row", async () => {
    const { result } = renderHook(() => useNotifications(), { wrapper: Wrapper });
    await waitFor(() => expect(fakeSocket.hasListener("mailbox.alert")).toBe(true));

    fakeSocket.emit("mailbox.alert", {});

    await waitFor(() => expect(result.current.notifications).toHaveLength(1));
    expect(result.current.notifications[0].title).toBe("Your connected mailbox stopped sending");
    expect(result.current.notifications[0].description).not.toBe("");
  });

  it("unregisters its handler on unmount", async () => {
    const { unmount } = renderHook(() => useNotifications(), { wrapper: Wrapper });
    await waitFor(() => expect(fakeSocket.hasListener("mailbox.alert")).toBe(true));
    unmount();
    expect(fakeSocket.hasListener("mailbox.alert")).toBe(false);
  });
});
