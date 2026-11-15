import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { CheckoutStart } from "@routeflow/types";
import { useCreateCheckout } from "./billing";
import { usePayPaymentDue } from "./payment-due";
import {
  closeEmbeddedCheckout,
  getEmbeddedCheckoutReturnPath,
  getEmbeddedCheckoutSecret,
} from "../checkout-embedded";

// SA-1139 PR-2 cases 11, 12 and 20: the mutations branch on `uiMode`, never on a null field.
const mockPost = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { get: jest.fn(), post: (...a: unknown[]) => mockPost(...a) },
}));
const mockGuard = jest.fn((_f?: () => void) => true);
jest.mock("../counter-cart-signal", () => ({
  guardCounterLeave: (f?: () => void) => mockGuard(f),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const embedded = (secret: string): CheckoutStart => ({
  uiMode: "embedded",
  sessionId: "cs_test_1",
  checkoutUrl: null,
  clientSecret: secret,
});
const SHOWN = { amountCents: 10_000, periodStart: "2026-10-01T00:00:00.000Z", cardBy: null };

describe("embedded checkout from the tenant mutations", () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    closeEmbeddedCheckout();
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_placeholder";
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    errSpy.mockRestore();
  });

  it("11: subscription checkout opens the panel with that secret and never leaves the page", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_a") });
    const { result } = renderHook(() => useCreateCheckout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_a"));
    expect(mockPost).toHaveBeenCalledWith("/billing/subscription/checkout");
    // jsdom logs "Not implemented: navigation" when location.assign runs.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("11: payment-due pay opens the panel and skips the counter's leave guard", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_b") });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(SHOWN));
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_b"));
    expect(mockGuard).not.toHaveBeenCalled();
  });

  // SA-1139 fix round 1 MUST 2: each caller opens with the return path its hosted twin uses.
  it("return path: plan checkout opens with the checkout success path", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_p") });
    const { result } = renderHook(() => useCreateCheckout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_p"));
    expect(getEmbeddedCheckoutReturnPath()).toBe("/settings/billing?checkout=success");
  });

  it("return path: payment-due pay opens with ?paid=1", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_q") });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(SHOWN));
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_q"));
    expect(getEmbeddedCheckoutReturnPath()).toBe("/settings/billing?paid=1");
  });

  it("return path: payment-due card add (no shown terms) opens with ?paid=1&card=1, never a payment path", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_r") });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(undefined));
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_r"));
    const path = getEmbeddedCheckoutReturnPath() ?? "";
    expect(path).toBe("/settings/billing?paid=1&card=1");
    expect(new URLSearchParams(path.split("?")[1]).get("card")).toBe("1");
  });

  it("12: no publishable key fails the mutation, logs once and opens nothing", async () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    mockPost.mockResolvedValue({ data: embedded("cs_secret_c") });
    const { result } = renderHook(() => useCreateCheckout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getEmbeddedCheckoutSecret()).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("12: the same failure on payment-due pay opens nothing and skips the leave guard", async () => {
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    mockPost.mockResolvedValue({ data: embedded("cs_secret_d") });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(SHOWN));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getEmbeddedCheckoutSecret()).toBeNull();
    expect(mockGuard).not.toHaveBeenCalled();
  });

  it("20: every click creates a fresh session; a closed panel's secret is never reused", async () => {
    mockPost
      .mockResolvedValueOnce({ data: embedded("cs_old") })
      .mockResolvedValueOnce({ data: embedded("cs_new") });
    const { result } = renderHook(() => useCreateCheckout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_old"));
    act(() => closeEmbeddedCheckout());
    expect(getEmbeddedCheckoutSecret()).toBeNull();
    act(() => result.current.mutate());
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_new"));
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});

// Lead SHOULD on PR-1: a second Pay answers 409 CATCHUP_SESSION_OPEN. The shared toast map says "Wait for it to
// complete or expire", which is wrong for someone who just tapped Pay on the embedded form.
describe("a second Pay while a session is open (CATCHUP_SESSION_OPEN)", () => {
  it("shows no global toast from the shared map; other 409s still do", async () => {
    const { MutationCache } = await import("@tanstack/react-query");
    const { handleMutationError } = await import("../mutation-error-toast");
    const toast = jest.fn();
    const cache = new MutationCache({
      onError: (error, _v, _c, mutation) =>
        handleMutationError(error, mutation, toast, { push: jest.fn() }),
    });
    const client = new QueryClient({
      mutationCache: cache,
      defaultOptions: { mutations: { retry: false } },
    });
    const w = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const open = Object.assign(new Error("409"), {
      response: { status: 409, data: { code: "CATCHUP_SESSION_OPEN" } },
    });
    mockPost.mockRejectedValueOnce(open);
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper: w });
    act(() => result.current.mutate(SHOWN));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast).not.toHaveBeenCalled();

    const other = Object.assign(new Error("409"), {
      response: { status: 409, data: { code: "PAYMENT_NOT_DUE" } },
    });
    mockPost.mockRejectedValueOnce(other);
    act(() => result.current.mutate(SHOWN));
    await waitFor(() => expect(toast).toHaveBeenCalled());
  });
});
