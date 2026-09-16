/**
 * Lite-L2 (WP7): `usePlanFlag` reads the shared `useSubscription` query and reports the
 * three-valued {enabled, resolved, failed} contract `lib/plan-gated-nav.ts`'s
 * `planFlagVisible` expects. Pinned behaviourally through the real hook + a real
 * QueryClient, same pattern as addons.delivery-access.test.tsx.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { usePlanFlag } from "./plan-flags";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("usePlanFlag", () => {
  it("resolved + flag present -> enabled true", async () => {
    mockedGet.mockResolvedValue({ data: { flags: ["flag.estimates", "flag.returns"] } });

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it("resolved + flag absent -> enabled false", async () => {
    mockedGet.mockResolvedValue({ data: { flags: ["flag.returns"] } });

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("query failure -> failed true, enabled false, resolved false", async () => {
    mockedGet.mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.enabled).toBe(false);
    expect(result.current.resolved).toBe(false);
  });

  it("missing flags array on the response -> enabled false, not a throw", async () => {
    mockedGet.mockResolvedValue({ data: {} });

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("passes through opts.enabled to hold the query off", () => {
    const { result } = renderHook(() => usePlanFlag("flag.estimates", { enabled: false }), {
      wrapper: Wrapper,
    });

    expect(mockedGet).not.toHaveBeenCalled();
    expect(result.current).toEqual({ enabled: false, resolved: false, failed: false });
  });
});
