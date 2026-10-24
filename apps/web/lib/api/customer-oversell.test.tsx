import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CUSTOMER_OVERSELL_REASON,
  OVERSELL_POLICY_KEY,
  useSetCustomerOversell,
} from "./customer-oversell";

/**
 * The customer page's out-of-stock override writes the CUSTOMER row of `orders.buyerOversell`:
 * allow = PUT value "backorder", deny = PUT value "off", inherit = DELETE (scope in the query, the
 * audit reason in the body). The component test mocks this hook, so the exact request shapes are
 * pinned HERE with `toStrictEqual` (an extra, missing or renamed field is a red test).
 */
const put = jest.fn();
const del = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

const CUSTOMER = "cust-1";
const URL = `/policies/${OVERSELL_POLICY_KEY}`;

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSetCustomerOversell(), { wrapper });
  return { result, invalidate };
}

beforeEach(() => {
  put.mockReset().mockResolvedValue({ data: {} });
  del.mockReset().mockResolvedValue({ data: {} });
});

describe("useSetCustomerOversell", () => {
  it('allow: PUT value "backorder" at CUSTOMER scope, with the audit reason; no DELETE', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync({ customerId: CUSTOMER, override: "allow" });
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe(URL);
    expect(put.mock.calls[0][1]).toStrictEqual({
      scopeType: "CUSTOMER",
      scopeId: CUSTOMER,
      value: "backorder",
      reason: CUSTOMER_OVERSELL_REASON,
    });
    expect(put.mock.calls[0]).toHaveLength(2);
    expect(del).not.toHaveBeenCalled();
  });

  it('deny: PUT value "off" at CUSTOMER scope, with the audit reason; no DELETE', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync({ customerId: CUSTOMER, override: "deny" });
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe(URL);
    expect(put.mock.calls[0][1]).toStrictEqual({
      scopeType: "CUSTOMER",
      scopeId: CUSTOMER,
      value: "off",
      reason: CUSTOMER_OVERSELL_REASON,
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("inherit: DELETE with the scope in params and the reason in the body; no PUT", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.mutateAsync({ customerId: CUSTOMER, override: "inherit" });
    });
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0]).toBe(URL);
    expect(del.mock.calls[0][1]).toStrictEqual({
      params: { scopeType: "CUSTOMER", scopeId: CUSTOMER },
      data: { reason: CUSTOMER_OVERSELL_REASON },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it("a saved change refreshes the policies and the business setting; a failed one refreshes nothing", async () => {
    const ok = setup();
    await act(async () => {
      await ok.result.current.mutateAsync({ customerId: CUSTOMER, override: "allow" });
    });
    const keys = ok.invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toStrictEqual([["policies"], ["inventory-settings"]]);

    put.mockRejectedValueOnce(new Error("nope"));
    const bad = setup();
    await act(async () => {
      await expect(
        bad.result.current.mutateAsync({ customerId: CUSTOMER, override: "allow" }),
      ).rejects.toThrow("nope");
    });
    expect(bad.invalidate).not.toHaveBeenCalled();
  });
});
