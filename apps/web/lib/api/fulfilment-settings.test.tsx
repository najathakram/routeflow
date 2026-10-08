import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { FULFILMENT_SETTINGS_KEY, useUpdateFulfilmentSettings } from "./fulfilment-settings";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

describe("useUpdateFulfilmentSettings", () => {
  it("stores the new settings and invalidates the tenant caches (counter gate, capabilities)", async () => {
    const client = createTestQueryClient();
    const invalidate = jest.spyOn(client, "invalidateQueries");
    (apiClient.patch as jest.Mock).mockResolvedValue({
      data: { fingerprint: "fp-new", changed: true },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpdateFulfilmentSettings(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ counterSales: "on", fingerprint: "fp-old" });
    });
    expect(client.getQueryData(FULFILMENT_SETTINGS_KEY)).toEqual({ fingerprint: "fp-new" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tenant"] });
  });
});
