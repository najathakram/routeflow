import * as React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { API_ERROR_CODES } from "@routeflow/types";
import { isMappedEnableAddonError, useEnableAddon } from "./billing";

/**
 * M11: the enable call sends the owned count the page showed (`expectedQuantity`) so the server can refuse a
 * stale buy-more instead of cutting a pack, and a success seeds the subscription cache from the response.
 */
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: jest.fn() },
}));

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useEnableAddon (M11)", () => {
  beforeEach(() => post.mockReset());

  it("posts quantity AND expectedQuantity, and seeds the subscription cache from the response", async () => {
    const subscription = {
      planKey: "STARTER",
      addons: [{ sku: "CUSTOMER_PACK_100", quantity: 3 }],
    };
    post.mockResolvedValue({ data: { proratedNow: 0, billing: "MANUAL", subscription } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useEnableAddon(), { wrapper: wrapperFor(qc) });

    await act(async () => {
      await result.current.mutateAsync({
        sku: "CUSTOMER_PACK_100",
        quantity: 3,
        expectedQuantity: 2,
      });
    });

    expect(post).toHaveBeenCalledWith("/billing/addons/CUSTOMER_PACK_100/enable", {
      quantity: 3,
      expectedQuantity: 2,
    });
    await waitFor(() => expect(qc.getQueryData(["billing", "subscription"])).toEqual(subscription));
  });
});

describe("isMappedEnableAddonError (M11)", () => {
  const err = (code: string) => ({ response: { status: 409, data: { code } } });
  it.each([
    API_ERROR_CODES.ADDON_ANNUAL_NOT_SUPPORTED,
    API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN,
    API_ERROR_CODES.ADDON_QUANTITY_CHANGED,
    API_ERROR_CODES.ADDON_RAISE_UNBILLED_ROW,
  ])("%s is worded by the sheet itself (no second global toast)", (code) => {
    expect(isMappedEnableAddonError(err(code))).toBe(true);
  });
  it("an unrelated 409 keeps the global toast", () => {
    expect(isMappedEnableAddonError(err("SOMETHING_ELSE"))).toBe(false);
  });
});
