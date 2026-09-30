import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDeliveryHealth } from "./messaging";

const mockGet = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), patch: jest.fn(), post: jest.fn() },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useDeliveryHealth (#1965 review nit 5)", () => {
  beforeEach(() => mockGet.mockReset());

  it("a 404 (endpoint not shipped yet) resolves to null after exactly one call, without throwing", async () => {
    mockGet.mockRejectedValue({ response: { status: 404 } });
    const { result } = renderHook(() => useDeliveryHealth(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("a 500 is an error state with no data (the strip renders nothing) and is not retried", async () => {
    mockGet.mockRejectedValue({ response: { status: 500 } });
    const { result } = renderHook(() => useDeliveryHealth(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
});
