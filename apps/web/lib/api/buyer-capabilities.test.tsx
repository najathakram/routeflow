/**
 * Business profiles 1B — `useBuyerSellerCapabilities`: the buyer reads its active SELLER's
 * fulfilment capability from the buyer-safe `GET /buyer/capabilities` through the buyer client,
 * and never fires without an active seller (no X-Tenant-Slug → a doomed 400). The HTTP client is
 * mocked; TanStack Query runs for real. Fixtures are placeholders.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { getStoredActiveSeller } from "@/lib/buyer-auth";
import { useBuyerSellerCapabilities } from "./buyer-capabilities";

jest.mock("@/lib/buyer-api-client", () => ({ buyerApiClient: { get: jest.fn() } }));
jest.mock("@/lib/buyer-auth", () => ({ getStoredActiveSeller: jest.fn() }));
const get = buyerApiClient.get as jest.Mock;
const activeSeller = getStoredActiveSeller as jest.Mock;

const CAPS = {
  fulfilment: {
    methods: ["SHIP"],
    staffDefault: "SHIP",
    staffOpensAs: "order",
    portalMethods: ["SHIP"],
    portalDefault: "SHIP",
    counter: "off",
    fleet: false,
    consistent: true,
  },
};

function wrapper() {
  const client = createTestQueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  get.mockReset();
  activeSeller.mockReset();
});

describe("useBuyerSellerCapabilities", () => {
  it("reads GET /buyer/capabilities for the active seller", async () => {
    activeSeller.mockReturnValue({ tenant: { slug: "acme" } });
    get.mockResolvedValue({ data: CAPS });
    const { result } = renderHook(() => useBuyerSellerCapabilities(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toEqual(CAPS));
    expect(get).toHaveBeenCalledWith("/buyer/capabilities");
  });

  it("does not fire without an active seller", async () => {
    activeSeller.mockReturnValue(null);
    const { result } = renderHook(() => useBuyerSellerCapabilities(), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 20));
    expect(get).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
  });

  it("surfaces a failed read as an error (the page then shows today's screen)", async () => {
    activeSeller.mockReturnValue({ tenant: { slug: "acme" } });
    get.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useBuyerSellerCapabilities(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
