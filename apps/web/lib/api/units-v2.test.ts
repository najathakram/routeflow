import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { PRICES_V2_FLAG, usePricesV2Enabled } from "./units-v2";

const mockGet = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(QueryClientProvider, { client: createTestQueryClient() }, children);

beforeEach(() => mockGet.mockReset());

describe("usePricesV2Enabled — fail CLOSED", () => {
  it("is false for unknown / missing / unrelated flags", async () => {
    for (const data of [{}, { flags: undefined }, { flags: ["flag.units_v1", "flag.msrp"] }]) {
      mockGet.mockResolvedValue({ data });
      const { result, unmount } = renderHook(() => usePricesV2Enabled(), { wrapper });
      await waitFor(() => expect(mockGet).toHaveBeenCalled());
      expect(result.current).toBe(false);
      unmount();
      mockGet.mockClear();
    }
  });

  it("is true once flag.units_prices_v2 is served", async () => {
    mockGet.mockResolvedValue({ data: { flags: ["flag.units_v1", PRICES_V2_FLAG] } });
    const { result } = renderHook(() => usePricesV2Enabled(), { wrapper });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("enabled:false never calls the query fn and stays false", async () => {
    mockGet.mockResolvedValue({ data: { flags: [PRICES_V2_FLAG] } });
    const { result } = renderHook(() => usePricesV2Enabled({ enabled: false }), { wrapper });
    await new Promise((r) => setTimeout(r, 30));
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });
});
