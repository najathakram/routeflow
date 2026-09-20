/**
 * `useOrderUiV2` — the dark gate for the card-list order detail (LANE-S / order-ui-redesign).
 * It is ONE indirection over the in-development-surface flag (`developer_mode`), so this pins the
 * behaviour through the real hook: dark for every tenant by default, on only when granted, and
 * `resolved` reflects whether the addon list was actually read.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { useOrderUiV2 } from "./addons";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => jest.clearAllMocks());

describe("useOrderUiV2", () => {
  it("is dark for a tenant with no in-development addon", async () => {
    mockedGet.mockResolvedValue({ data: { addons: ["msrp"] } });
    const { result } = renderHook(() => useOrderUiV2(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("is on once the tenant has been granted developer_mode", async () => {
    mockedGet.mockResolvedValue({ data: { addons: ["developer_mode"] } });
    const { result } = renderHook(() => useOrderUiV2(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current.resolved).toBe(true);
  });

  it("fails dark, and reports unresolved, when the addon list cannot be read", async () => {
    mockedGet.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useOrderUiV2(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(result.current.enabled).toBe(false);
    expect(result.current.resolved).toBe(false);
  });
});
