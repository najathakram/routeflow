import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateOrder } from "./orders";

// SA-484a (#2406): useCreateOrder sends the replay key as the `Idempotency-Key` HEADER — POST
// /orders reads it there (B215) — and never in the request body.
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { post: (...a: unknown[]) => post(...a) },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("useCreateOrder — Idempotency-Key (SA-484a)", () => {
  beforeEach(() => post.mockReset().mockResolvedValue({ data: { id: "o1" } }));

  it("sends idempotencyKey as the header, stripped from the body", async () => {
    const { result } = renderHook(() => useCreateOrder(), { wrapper });
    result.current.mutate({ customerId: "c1", items: [], idempotencyKey: "k-1" } as any);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe("/orders");
    expect(body).not.toHaveProperty("idempotencyKey");
    expect(config).toEqual({ headers: { "Idempotency-Key": "k-1" } });
  });

  it("no key ⇒ no header (a plain create is unchanged)", async () => {
    const { result } = renderHook(() => useCreateOrder(), { wrapper });
    result.current.mutate({ customerId: "c1", items: [] } as any);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][2]).toBeUndefined();
  });
});
