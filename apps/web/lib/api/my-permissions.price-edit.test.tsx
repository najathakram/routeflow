import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePriceEditAllowed } from "./my-permissions";

const get = jest.fn();
jest.mock("../api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

let authUser: { id: string; role: string } | null = null;
jest.mock("../auth-context", () => ({
  useOptionalAuth: () => (authUser ? { user: authUser } : null),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

/**
 * SA-1034 rule 10: "Add custom item" follows the SERVER's mode-applied `priceEditAllowed`; a pending, failed or
 * missing answer reads as allowed (the server refuses with the same sentence), and only an OPERATOR is asked.
 */
describe("usePriceEditAllowed", () => {
  beforeEach(() => {
    get.mockReset();
    authUser = { id: "u1", role: "OPERATOR" };
  });

  it("an operator the server says may not edit prices is not allowed", async () => {
    get.mockResolvedValue({
      data: { groups: [], version: 1, mode: "live", priceEditAllowed: false },
    });
    const { result } = renderHook(() => usePriceEditAllowed(), { wrapper });
    expect(result.current).toBe(true); // pending: allowed
    await waitFor(() => expect(result.current).toBe(false));
    expect(get).toHaveBeenCalledWith("/users/me/permissions");
  });

  it("an operator the server says may is allowed", async () => {
    get.mockResolvedValue({
      data: { groups: [], version: 1, mode: "live", priceEditAllowed: true },
    });
    const { result } = renderHook(() => usePriceEditAllowed(), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(result.current).toBe(true);
  });

  it("a failed read, or an answer without the field, reads as allowed", async () => {
    get.mockRejectedValue(new Error("boom"));
    const failed = renderHook(() => usePriceEditAllowed(), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(failed.result.current).toBe(true);
    get.mockReset();
    get.mockResolvedValue({ data: { groups: [], version: 1, mode: "live" } });
    authUser = { id: "u2", role: "OPERATOR" };
    const stale = renderHook(() => usePriceEditAllowed(), { wrapper });
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(stale.result.current).toBe(true);
  });

  it("an account admin is allowed with no read", () => {
    authUser = { id: "a1", role: "TENANT_ADMIN" };
    const { result } = renderHook(() => usePriceEditAllowed(), { wrapper });
    expect(result.current).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("no signed-in user asks nothing and offers the control", () => {
    authUser = null;
    const { result } = renderHook(() => usePriceEditAllowed(), { wrapper });
    expect(result.current).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
