/**
 * B449 fix-round finding 2: `GET /customers/pending-portal-approvals` is
 * `@RequirePlanFlag("addon.buyer_portal")` — a dark flag every plan gets a courtesy
 * allow on EXCEPT an always-enforced one (LITE). `usePendingPortalApprovals` fired
 * unconditionally from two globally-mounted call sites (the header bell, the
 * customers list), so a LITE tenant got a real 403 there on every page load and
 * every 60s poll — the "stray toast with no gated navigation" half of B449.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { usePendingPortalApprovals } from "./portal-approvals";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mockSubscription(flags: string[] | undefined) {
  mockedGet.mockImplementation((url: string) => {
    if (url === "/billing/subscription") return Promise.resolve({ data: { flags } });
    if (url === "/customers/pending-portal-approvals") return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("usePendingPortalApprovals — B449 fix-round finding 2", () => {
  it("never fires the gated GET for a tenant resolved WITHOUT addon.buyer_portal (e.g. LITE)", async () => {
    mockSubscription(["flag.estimates"]); // resolved, buyer_portal absent
    renderHook(() => usePendingPortalApprovals(), { wrapper: Wrapper });

    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith("/billing/subscription"));
    expect(mockedGet).not.toHaveBeenCalledWith("/customers/pending-portal-approvals");
  });

  it("fires the gated GET once resolved WITH addon.buyer_portal", async () => {
    mockSubscription(["addon.buyer_portal"]);
    renderHook(() => usePendingPortalApprovals(), { wrapper: Wrapper });

    await waitFor(() =>
      expect(mockedGet).toHaveBeenCalledWith("/customers/pending-portal-approvals"),
    );
  });

  it("does not fire the gated GET while the flag is still resolving", () => {
    mockedGet.mockImplementation(() => new Promise(() => {})); // never resolves
    renderHook(() => usePendingPortalApprovals(), { wrapper: Wrapper });

    expect(mockedGet).not.toHaveBeenCalledWith("/customers/pending-portal-approvals");
  });

  it("fires the gated GET on a fetch failure (fail open, matches every other flag consumer)", async () => {
    mockedGet.mockImplementation((url: string) => {
      if (url === "/billing/subscription") return Promise.reject(new Error("network error"));
      if (url === "/customers/pending-portal-approvals") return Promise.resolve({ data: [] });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderHook(() => usePendingPortalApprovals(), { wrapper: Wrapper });

    await waitFor(() =>
      expect(mockedGet).toHaveBeenCalledWith("/customers/pending-portal-approvals"),
    );
  });

  it("fires ZERO requests for a role the caller disables (e.g. CUSTOMER/DRIVER) — fix-round finding 2-new", async () => {
    // GET /billing/subscription is @Roles(OPERATOR)-gated same as the approvals
    // endpoint — a caller passing enabled: false (a CUSTOMER/DRIVER header) must
    // never fire the flag-resolution query either, or that alone 403s.
    mockSubscription(["addon.buyer_portal"]);
    renderHook(() => usePendingPortalApprovals({ enabled: false }), { wrapper: Wrapper });

    // Give react-query a tick to settle so a wrongly-fired request would show up.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
