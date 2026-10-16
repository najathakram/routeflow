import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { paymentDuePollMs, safeCheckoutUrl, usePaymentDue, usePayPaymentDue } from "./payment-due";

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
  },
}));
const mockGuard = jest.fn((_f?: () => void) => false);
jest.mock("../counter-cart-signal", () => ({
  guardCounterLeave: (f?: () => void) => mockGuard(f),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const BILL_SHOWN = {
  amountCents: 10_000,
  periodStart: "2026-10-01T00:00:00.000Z",
  cardBy: null,
};
const CARD_SHOWN = { amountCents: 0, periodStart: null, cardBy: "2026-10-29T12:00:00.000Z" };

describe("usePaymentDue", () => {
  beforeEach(() => jest.clearAllMocks());

  it("reads GET /billing/payment-due", async () => {
    const body = {
      due: true,
      pastDue: false,
      amountCents: 10_000,
      periodLabel: "October 2026",
      periodStart: "2026-10-01T00:00:00.000Z",
      cardNeeded: false,
      chargeStartsOn: null,
    };
    mockGet.mockResolvedValue({ data: body });
    const { result } = renderHook(() => usePaymentDue(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(body));
    expect(mockGet).toHaveBeenCalledWith("/billing/payment-due");
  });

  it("does not fetch when disabled", () => {
    renderHook(() => usePaymentDue({ enabled: false }), { wrapper });
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("usePayPaymentDue", () => {
  // jsdom cannot intercept window.location (see lib/api-client.test.ts), so the redirect is proven where it is
  // routed: through the counter's leave guard, and only for an https checkout url.
  beforeEach(() => jest.clearAllMocks());

  it("POSTs the pay route and leaves for the checkout through the counter's leave guard", async () => {
    mockGuard.mockReturnValueOnce(true); // parked: nothing navigates in jsdom
    mockPost.mockResolvedValue({ data: { checkoutUrl: "https://checkout.stripe.test/c/1" } });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(BILL_SHOWN));
    await waitFor(() => expect(mockGuard).toHaveBeenCalledTimes(1));
    expect(mockPost).toHaveBeenCalledWith("/billing/payment-due/pay", { shown: BILL_SHOWN });
    expect(typeof mockGuard.mock.calls[0]?.[0]).toBe("function");
  });

  it("542c: the card add sends the terms it displayed ($0, no period, the card deadline)", async () => {
    mockGuard.mockReturnValueOnce(true);
    mockPost.mockResolvedValue({ data: { checkoutUrl: "https://checkout.stripe.test/c/1" } });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(CARD_SHOWN));
    await waitFor(() => expect(mockPost).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith("/billing/payment-due/pay", { shown: CARD_SHOWN });
  });

  it("refuses a non-https checkout url (never reaches the leave)", async () => {
    mockPost.mockResolvedValue({ data: { checkoutUrl: "javascript:alert(1)" } });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper });
    act(() => result.current.mutate(BILL_SHOWN));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGuard).not.toHaveBeenCalled();
  });
});

describe("usePayPaymentDue error path", () => {
  beforeEach(() => jest.clearAllMocks());

  it("a refused pay (409) still invalidates the payment-due read so a stale banner re-reads", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const spy = jest.spyOn(client, "invalidateQueries");
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    mockPost.mockRejectedValue(new Error("409"));
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper: wrap });
    act(() => result.current.mutate(BILL_SHOWN));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["billing", "payment-due"] });
  });

  it("542c: a 409 PAYMENT_TERMS_CHANGED re-reads the banner and leaves the app-wide error toast on (no localErrorToast opt-out)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const spy = jest.spyOn(client, "invalidateQueries");
    const wrap = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    mockPost.mockRejectedValue({
      response: { status: 409, data: { code: "PAYMENT_TERMS_CHANGED" } },
    });
    const { result } = renderHook(() => usePayPaymentDue(), { wrapper: wrap });
    act(() => result.current.mutate(CARD_SHOWN));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["billing", "payment-due"] });
    const meta = client.getMutationCache().getAll()[0]?.options.meta as
      Record<string, unknown> | undefined;
    expect(meta?.localErrorToast).toBeUndefined();
  });
});

describe("safeCheckoutUrl", () => {
  it("passes https only", () => {
    expect(safeCheckoutUrl("https://checkout.stripe.test/c/1")).toBe(
      "https://checkout.stripe.test/c/1",
    );
    expect(safeCheckoutUrl("http://x.test")).toBeNull();
    expect(safeCheckoutUrl("javascript:alert(1)")).toBeNull();
    expect(safeCheckoutUrl(undefined)).toBeNull();
  });
});

describe("paymentDuePollMs", () => {
  const view = (o: Record<string, unknown>) => ({ due: false, cardNeeded: false, ...o }) as never;
  it("a payment that is due polls every 30 s (another tab may pay it)", () => {
    expect(paymentDuePollMs(view({ due: true }), "")).toBe(30_000);
  });
  it("a card reminder does NOT poll every 30 s for weeks: 5 min by default", () => {
    expect(paymentDuePollMs(view({ cardNeeded: true }), "")).toBe(300_000);
  });
  it("a card reminder polls fast only while ?paid=1 is present (the card is being confirmed)", () => {
    expect(paymentDuePollMs(view({ cardNeeded: true }), "?paid=1&card=1")).toBe(30_000);
  });
  it("nothing due and no card needed: no polling; no data yet: none", () => {
    expect(paymentDuePollMs(view({}), "")).toBe(false);
    expect(paymentDuePollMs(undefined, "")).toBe(false);
  });
});
