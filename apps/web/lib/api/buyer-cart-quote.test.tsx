import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useBuyerCartQuote } from "./buyer";

/**
 * B304 / SA-1172 K5/K8: the quote request is the cart exactly as the submit sends it, keyed by seller + cart, never retried on a
 * 4xx or a 429, and a different seller's figures are never shown while the new seller's quote loads.
 */
const post = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { post: (...a: unknown[]) => post(...a), get: jest.fn() },
}));

const ITEMS = [
  { productId: "p1", qty: 2 },
  { productId: "p2", qty: 24, boxes: 2, pieces: 0 },
];
const quoteFor = (total: number) => ({ subtotal: 1, tax: 0, levy: 0, total, taxExempt: false });

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return Wrapper;
}

beforeEach(() => {
  jest.useFakeTimers();
  post.mockReset();
});
afterEach(() => jest.useRealTimers());

const settle = async () => {
  await act(async () => {
    jest.advanceTimersByTime(450);
  });
};

describe("useBuyerCartQuote", () => {
  it("posts exactly the cart (every line) plus the fulfil path", async () => {
    post.mockResolvedValue({ data: quoteFor(10) });
    const { result } = renderHook(() => useBuyerCartQuote("acme", ITEMS, "ROUTE" as never), {
      wrapper: wrapper(),
    });
    await settle();
    await waitFor(() => expect(result.current.quote?.total).toBe(10));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/buyer/cart/quote", { items: ITEMS, fulfillPath: "ROUTE" });
  });

  it("18: a 429 or a 400 is never retried and leaves no quote (the page shows its fallback)", async () => {
    post.mockRejectedValue({ response: { status: 429 } });
    const { result } = renderHook(() => useBuyerCartQuote("acme", ITEMS, undefined), {
      wrapper: wrapper(),
    });
    await settle();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.quote).toBeUndefined();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("21: switching seller with the same cart never shows the other seller's quote", async () => {
    post.mockResolvedValueOnce({ data: quoteFor(10) });
    const { result, rerender } = renderHook(
      ({ slug }: { slug: string }) => useBuyerCartQuote(slug, ITEMS, undefined),
      { wrapper: wrapper(), initialProps: { slug: "acme" } },
    );
    await settle();
    await waitFor(() => expect(result.current.quote?.total).toBe(10));
    post.mockReturnValueOnce(new Promise(() => undefined)); // the other seller's quote is still loading
    rerender({ slug: "beta" });
    await settle();
    expect(result.current.quote).toBeUndefined();
    expect(result.current.busy).toBe(true);
  });

  it("an unchanged seller keeps the previous figures (busy) while a new cart's quote loads", async () => {
    post.mockResolvedValueOnce({ data: quoteFor(10) });
    const { result, rerender } = renderHook(
      ({ items }: { items: typeof ITEMS }) => useBuyerCartQuote("acme", items, undefined),
      { wrapper: wrapper(), initialProps: { items: ITEMS } },
    );
    await settle();
    await waitFor(() => expect(result.current.quote?.total).toBe(10));
    post.mockReturnValueOnce(new Promise(() => undefined));
    rerender({ items: [{ productId: "p1", qty: 3 }] });
    expect(post).toHaveBeenCalledTimes(1); // debounced: a changed cart is not sent until it settles
    await settle();
    expect(result.current.quote?.total).toBe(10);
    expect(result.current.busy).toBe(true);
  });

  it("no lines or disabled: nothing is requested", async () => {
    const { result } = renderHook(() => useBuyerCartQuote("acme", [], undefined), {
      wrapper: wrapper(),
    });
    await settle();
    expect(post).not.toHaveBeenCalled();
    expect(result.current).toEqual({ quote: undefined, busy: false });
  });
});
