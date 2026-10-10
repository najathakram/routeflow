/**
 * `useActiveOrderForCustomer` (SA-676 / review M4): the merge preview searches for the SAME target order
 * create would fold into, so it sends the order's fulfil path to GET /orders/active, and a path change
 * is a separate query (never the other path's cached answer). The HTTP client is mocked.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { useActiveOrderForCustomer } from "./orders";

jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
const get = apiClient.get as jest.Mock;

function wrapper() {
  const client = createTestQueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: null });
});

describe("useActiveOrderForCustomer", () => {
  it("sends the order's fulfillPath with the customer id", async () => {
    renderHook(() => useActiveOrderForCustomer("c1", "SHIP"), { wrapper: wrapper() });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get).toHaveBeenCalledWith("/orders/active", {
      params: { customerId: "c1", fulfillPath: "SHIP" },
    });
  });

  it("a path change re-asks for that path (its own query, never the other path's answer)", async () => {
    const { rerender } = renderHook(
      ({ path }: { path: "ROUTE" | "SHIP" }) => useActiveOrderForCustomer("c1", path),
      { wrapper: wrapper(), initialProps: { path: "ROUTE" as "ROUTE" | "SHIP" } },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    rerender({ path: "SHIP" });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get.mock.calls.map((c) => c[1].params.fulfillPath)).toEqual(["ROUTE", "SHIP"]);
  });

  it("no customer: no request", async () => {
    renderHook(() => useActiveOrderForCustomer(undefined, "SHIP"), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
  });
});
