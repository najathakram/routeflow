/**
 * Lite-L2 (WP7); feature grants v2 brief A: `usePlanFlag` reads `useTenantFeatures`
 * (`GET /tenants/me/features`) and reports the three-valued {enabled, resolved, failed}
 * contract `lib/plan-gated-nav.ts`'s `planFlagVisible` expects. Pinned behaviourally through
 * the real hook + a real QueryClient, same pattern as addons.delivery-access.test.tsx.
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
    mockedGet.mockResolvedValue({ data: { effective: ["flag.estimates", "flag.returns"] } });

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it("resolved + flag absent -> enabled false", async () => {
    mockedGet.mockResolvedValue({ data: { effective: ["flag.returns"] } });

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("query failure -> failed true, enabled true (q.data undefined fails open), resolved false", async () => {
    // q.data is undefined here, so the fail-open `flags === undefined` branch fires too —
    // harmless per Finding 5, since planFlagVisible ignores `enabled` while unresolved and
    // this caller (resolved: false) never treats a failed fetch as "gate granted" on its own.
    mockedGet.mockRejectedValue(new Error("network error"));

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.enabled).toBe(true);
    expect(result.current.resolved).toBe(false);
  });

  it("missing flags key on the response -> fail OPEN (enabled true), not a throw", async () => {
    // An old API build (Railway deploy skew / code-only rollback) can resolve successfully
    // with no `flags` key at all — that must read as "unresolved gate" (fail open), never
    // as "resolved, zero grants" (see Finding 5: `?? []` collapsed these two cases).
    mockedGet.mockResolvedValue({ data: {} });

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(true);
  });

  it("resolved + flags: [] (real empty grant list) -> enabled false (still gates)", async () => {
    mockedGet.mockResolvedValue({ data: { effective: [] } });

    const { result } = renderHook(() => usePlanFlag("flag.estimates"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.enabled).toBe(false);
  });

  it("passes through opts.enabled to hold the query off", () => {
    // q.data is undefined while the query is held off, so `enabled` reads `true` here too
    // (fail open) — harmless, since `resolved: false` means no caller treats it as granted.
    const { result } = renderHook(() => usePlanFlag("flag.estimates", { enabled: false }), {
      wrapper: Wrapper,
    });

    expect(mockedGet).not.toHaveBeenCalled();
    expect(result.current).toEqual({ enabled: true, resolved: false, failed: false });
  });
});
