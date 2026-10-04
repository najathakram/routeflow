import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateCounterSale } from "./counter-sale";

const post = jest.fn();
jest.mock("../api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
jest.mock("../tenant-features", () => ({ useTenantFeatures: () => ({ data: undefined }) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

describe("useCreateCounterSale: the Idempotency-Key header", () => {
  beforeEach(() => post.mockReset());

  it("posts the dto with the key as an Idempotency-Key header and returns the response body", async () => {
    const body = { orderId: "o1", paymentRecorded: true };
    post.mockResolvedValue({ data: body });
    const { result } = renderHook(() => useCreateCounterSale(), { wrapper });
    const dto = { walkIn: true, items: [], payment: { method: "CASH" as const } };
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync({ dto, idempotencyKey: "key-abc" });
    });
    expect(post).toHaveBeenCalledWith("/orders/counter-sale", dto, {
      headers: { "Idempotency-Key": "key-abc" },
    });
    expect(res).toEqual(body);
  });
});
