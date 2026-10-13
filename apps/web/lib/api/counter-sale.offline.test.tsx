import * as React from "react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { useCounterSaleByKey, useCreateCounterSale } from "./counter-sale";

/**
 * CQ-29 (S1): through a REAL QueryClient whose online manager says OFFLINE, the till's sale request is attempted and a network
 * failure REJECTS. React Query's default networkMode ("online") would pause it: `mutateAsync` would never settle and the screen
 * would stay "sending" until the connection returned. (The screen tests mock these hooks, so only this meets the pause.)
 */
const post = jest.fn();
const get = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) },
}));

const NETWORK_ERROR = { code: "ERR_NETWORK", message: "Network Error" };
let client: QueryClient;
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
const settled = <T,>(p: Promise<T>) =>
  Promise.race([
    p.then(
      (value) => ({ state: "resolved" as const, value }),
      (error) => ({ state: "rejected" as const, error }),
    ),
    new Promise<{ state: "pending" }>((res) => setTimeout(() => res({ state: "pending" }), 300)),
  ]);

beforeEach(() => {
  jest.clearAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  onlineManager.setOnline(false);
});
afterEach(() => onlineManager.setOnline(true));

describe("counter sale mutations while the online manager says offline (CQ-29)", () => {
  it("the sale request is attempted and its network failure REJECTS (it is not paused)", async () => {
    post.mockRejectedValueOnce(NETWORK_ERROR);
    const { result } = renderHook(() => useCreateCounterSale(), { wrapper: Wrapper });
    const outcome = await settled(
      result.current.mutateAsync({
        dto: { walkIn: true, items: [], payment: { method: "CASH", amount: 1 } },
        idempotencyKey: "key-1",
      }),
    );
    expect(outcome.state).toBe("rejected");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][2]).toEqual({ headers: { "Idempotency-Key": "key-1" } });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("the by-key status check is attempted too", async () => {
    get.mockRejectedValueOnce(NETWORK_ERROR);
    const { result } = renderHook(() => useCounterSaleByKey(), { wrapper: Wrapper });
    const outcome = await settled(
      result.current.mutateAsync({ idempotencyKey: "key-1", method: "CASH" }),
    );
    expect(outcome.state).toBe("rejected");
    expect(get).toHaveBeenCalledTimes(1);
  });
});
