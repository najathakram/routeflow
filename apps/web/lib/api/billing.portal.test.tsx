import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useBillingPortal } from "./billing";

const mockPost = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { get: jest.fn(), post: (...a: unknown[]) => mockPost(...a) },
}));
const mockGuard = jest.fn((_f?: () => void) => false);
jest.mock("../counter-cart-signal", () => ({
  guardCounterLeave: (f?: () => void) => mockGuard(f),
}));

/**
 * SA-733r6 (B4): leaving for Stripe never navigates the counter tab (an open cart stays) - it claims a new tab on the
 * click and points it at Stripe once the URL arrives; with no new tab allowed it falls back through the leave guard.
 */
function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function fakeTab() {
  return { opener: "x", close: jest.fn(), location: { href: "" } } as any;
}

describe("useBillingPortal", () => {
  let openSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    openSpy = jest.spyOn(window, "open");
  });
  afterEach(() => openSpy.mockRestore());

  it("Pay: claims a new tab synchronously, then sends it to the hosted invoice page", async () => {
    const tab = fakeTab();
    openSpy.mockReturnValue(tab);
    mockPost.mockResolvedValue({
      data: { portalUrl: "https://p.example/1", hostedInvoiceUrl: "https://i.example/1" },
    });
    const { result } = renderHook(() => useBillingPortal(), { wrapper });
    act(() => result.current.mutate({ intent: "pay" }));
    expect(openSpy).toHaveBeenCalledTimes(1); // before the request resolves
    expect(tab.opener).toBeNull();
    await waitFor(() => expect(tab.location.href).toBe("https://i.example/1"));
    expect(mockGuard).not.toHaveBeenCalled(); // the cart tab is untouched: no "Discard this sale?"
  });

  it("Update payment: the portal; and the pay link when the portal is down", async () => {
    const tab = fakeTab();
    openSpy.mockReturnValue(tab);
    mockPost.mockResolvedValue({
      data: { portalUrl: null, hostedInvoiceUrl: "https://i.example/1" },
    });
    const { result } = renderHook(() => useBillingPortal(), { wrapper });
    act(() => result.current.mutate({ intent: "update-payment" }));
    await waitFor(() => expect(tab.location.href).toBe("https://i.example/1"));
  });

  it("a failed request closes the claimed tab", async () => {
    const tab = fakeTab();
    openSpy.mockReturnValue(tab);
    mockPost.mockRejectedValue(new Error("503"));
    const { result } = renderHook(() => useBillingPortal(), { wrapper });
    act(() => result.current.mutate({ intent: "pay" }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
  });

  it("no new tab allowed: this tab leaves through the counter's leave guard", async () => {
    openSpy.mockReturnValue(null);
    mockPost.mockResolvedValue({
      data: { portalUrl: "https://p.example/1", hostedInvoiceUrl: null },
    });
    mockGuard.mockReturnValue(true); // a cart is open: the guard parks the leave
    const { result } = renderHook(() => useBillingPortal(), { wrapper });
    act(() => result.current.mutate({ intent: "update-payment" }));
    await waitFor(() => expect(mockGuard).toHaveBeenCalledTimes(1));
  });
});
