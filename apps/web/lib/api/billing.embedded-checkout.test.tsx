import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { BILLING_RETURN_PATHS, type CheckoutStart } from "@routeflow/types";
import { shownTermsOf } from "../payment-due";
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

// The server's answer carries the return path (SA-1154); the plan checkout's own session returns to ?checkout=success.
const embedded = (
  secret: string,
  returnPath: string = BILLING_RETURN_PATHS.plan,
): CheckoutStart => ({
  uiMode: "embedded",
  sessionId: "cs_test_1",
  checkoutUrl: null,
  clientSecret: secret,
  returnPath,
});
const hosted: CheckoutStart = {
  uiMode: "hosted",
  sessionId: "cs_test_h",
  checkoutUrl: "https://pay.test/cs_test_h",
  clientSecret: null,
  returnPath: null,
};
// The payload the banner really sends: shownTermsOf on the view it holds (see PaymentDueBanner.return-path.test.tsx).
const OWED_VIEW = {
  due: true,
  pastDue: true,
  amountCents: 10_000,
  periodLabel: "October 2026",
  periodStart: "2026-10-01T00:00:00.000Z",
  cardNeeded: false,
  chargeStartsOn: null,
  cardBy: null,
};
const SHOWN = shownTermsOf(OWED_VIEW);

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

  // SA-1154: the web opens with the path the SERVER sent; it never works one out from what it posted.
  it("O1: plan checkout (no body) opens with the server's path, ?checkout=success", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_p", BILLING_RETURN_PATHS.plan) });
    const { result } = renderHook(() => useCreateCheckout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_p"));
    expect(mockPost).toHaveBeenCalledWith("/billing/subscription/checkout");
    expect(getEmbeddedCheckoutReturnPath()).toBe("/settings/billing?checkout=success");
  });

  it("O1h: plan checkout hosted leaves through Stripe's redirect: nothing opens, no path is kept", async () => {
    mockPost.mockResolvedValue({ data: hosted });
    const { result } = renderHook(() => useCreateCheckout(), { wrapper });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getEmbeddedCheckoutSecret()).toBeNull();
    expect(getEmbeddedCheckoutReturnPath()).toBeNull();
    // jsdom reports the page change it cannot perform: the hosted leave ran
    expect(String(errSpy.mock.calls.flat())).toMatch(/navigation/);
  });

  it("payment-due pay opens with the server's path (the banner's own shown terms are sent)", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_q", BILLING_RETURN_PATHS.pay) });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(SHOWN));
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_q"));
    expect(getEmbeddedCheckoutReturnPath()).toBe("/settings/billing?paid=1");
  });

  // O4 is API-only (no web caller sends no body); the web still pushes whatever the server decided.
  it("O4: a pay with no body still opens with the server's path, not one worked out from the body", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_o4", BILLING_RETURN_PATHS.cardAdd) });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(undefined));
    await waitFor(() => expect(getEmbeddedCheckoutSecret()).toBe("cs_secret_o4"));
    expect(getEmbeddedCheckoutReturnPath()).toBe("/settings/billing?paid=1&card=1");
  });

  it.each([
    ["another site", "https://evil.example/x"],
    ["a scheme-relative address", "//evil.example/settings/billing?paid=1"],
    ["a payment path with another value", "/settings/billing?paid=2"],
    ["a known path with a suffix", "/settings/billing?paid=1&card=1&x=1"],
    ["a script address", "javascript:alert(1)"],
    ["an empty path", ""],
  ])(
    "O10: an embedded start whose returnPath is %s is refused before anything mounts (plan checkout)",
    async (_name, bad) => {
      mockPost.mockResolvedValue({ data: embedded("cs_secret_bad", bad) });
      const { result } = renderHook(() => useCreateCheckout(), { wrapper });
      act(() => result.current.mutate());
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(getEmbeddedCheckoutSecret()).toBeNull();
      expect(errSpy).toHaveBeenCalledTimes(1); // logged once
      expect(JSON.stringify(errSpy.mock.calls)).not.toContain("cs_secret_bad");
      // a plain error, no response body: the billing page words it as its fixed "couldn't start checkout" line
      expect((result.current.error as { response?: unknown }).response).toBeUndefined();
    },
  );

  it("O10: the same refusal on payment-due pay opens nothing and never leaves", async () => {
    mockPost.mockResolvedValue({ data: embedded("cs_secret_bad2", "https://evil.example/x") });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(SHOWN));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(getEmbeddedCheckoutSecret()).toBeNull();
    expect(mockGuard).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
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
