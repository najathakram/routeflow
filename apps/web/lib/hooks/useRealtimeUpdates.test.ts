/**
 * B343 — customer statement and available-credit figures were never invalidated
 * when a credit note changed: the `creditNote.created` handler never read the
 * `customerId` already on its payload, and `creditNote.voided` didn't exist as a
 * socket event at all (a remote void reached no open tab). Fails before the fix
 * because neither handler invalidates `["customers", <id>, "statement"]`.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { useRealtimeUpdates } from "./useRealtimeUpdates";
import { OP_KEYS } from "../auth-keys";

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
  disconnectSocket: () => {},
}));

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ToastProvider, null, children),
    );
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OP_KEYS.accessToken, "tok");
});

describe("useRealtimeUpdates — creditNote.created / creditNote.voided (B343)", () => {
  it("REG-B343: creditNote.created invalidates the customer's statement query", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = jest.spyOn(client, "invalidateQueries");

    renderHook(() => useRealtimeUpdates(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(fakeSocket.hasListener("creditNote.created")).toBe(true));

    fakeSocket.emit("creditNote.created", {
      creditNoteId: "cn-1",
      creditNoteNumber: "CN-2026-0001",
      customerId: "cust-9",
    });

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["customers", "cust-9", "statement"] }),
    );
  });

  it("REG-B343: creditNote.voided invalidates credit-notes AND the customer's statement query", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = jest.spyOn(client, "invalidateQueries");

    renderHook(() => useRealtimeUpdates(), { wrapper: makeWrapper(client) });
    await waitFor(() => expect(fakeSocket.hasListener("creditNote.voided")).toBe(true));

    fakeSocket.emit("creditNote.voided", {
      creditNoteId: "cn-1",
      creditNoteNumber: "CN-2026-0001",
      customerId: "cust-9",
    });

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ["customers", "cust-9", "statement"] }),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["credit-notes"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["credit-notes", "cn-1"] });
  });
});
