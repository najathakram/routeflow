import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { API_ERROR_CODES } from "@routeflow/types";
import { isDayClosedRefusal } from "@/lib/day-closed-copy";
import { handleMutationError } from "@/lib/mutation-error-toast";
import {
  useDeleteInvoicePayment,
  useRecordInvoicePayment,
  useRecordPaymentStandalone,
  useSetCheckStatus,
  useUpdateInvoicePayment,
  useVoidPayment,
} from "./invoices";
import { useApprovePaymentRequest, useRejectPaymentRequest } from "./payment-requests";
import { useRecordPayment } from "./bookkeeping";

/**
 * Row 348: the payment hooks behind the closed-day surfaces keep the app-wide error toast QUIET for a closed-day
 * refusal (`meta.localErrorToast`), because every one of those pages toasts it itself. Both day-closed codes answer
 * true, any other 409 answers false (it still reaches the global toast, in fixed copy).
 */
jest.mock("@/lib/api-client", () => {
  const ok = jest.fn().mockResolvedValue({ data: {} });
  return { __esModule: true, apiClient: { get: ok, post: ok, patch: ok, delete: ok, put: ok } };
});

const refusal = (status: number, code?: string) =>
  Object.assign(new Error("Request failed"), { response: { status, data: { code } } });

type Predicate = (error: unknown) => boolean;

/** Run `make()` once and return the `meta` the mutation registered in the cache. */
async function metaOf(make: () => { mutate: (v: any, o?: any) => void }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(make, { wrapper });
  await act(async () => {
    result.current.mutate(
      { id: "x", invoiceId: "i", paymentId: "p" },
      { onError: () => undefined },
    );
  });
  return qc.getMutationCache().getAll()[0]?.meta as { localErrorToast?: Predicate } | undefined;
}

const HOOKS: Array<[string, () => { mutate: (v: any, o?: any) => void }]> = [
  ["useRecordPaymentStandalone", () => useRecordPaymentStandalone()],
  ["useVoidPayment", () => useVoidPayment()],
  ["useApprovePaymentRequest", () => useApprovePaymentRequest()],
  [
    "useRecordPayment({ localErrorToast })",
    () => useRecordPayment({ localErrorToast: isDayClosedRefusal }),
  ],
  // already carried the meta before this row; pinned with the rest so the set stays whole
  ["useRecordInvoicePayment", () => useRecordInvoicePayment()],
  ["useUpdateInvoicePayment", () => useUpdateInvoicePayment()],
  ["useDeleteInvoicePayment", () => useDeleteInvoicePayment()],
  ["useSetCheckStatus", () => useSetCheckStatus()],
];

describe("payment hooks: meta.localErrorToast answers a closed-day refusal (row 348)", () => {
  it.each(HOOKS)("%s", async (_name, make) => {
    const predicate = (await metaOf(make))?.localErrorToast;
    expect(typeof predicate).toBe("function");
    expect(predicate!(refusal(409, API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED))).toBe(true);
    expect(predicate!(refusal(409, API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE))).toBe(true);
    // any other failure is not the page's to own here: it reaches the global toast
    expect(predicate!(refusal(409, API_ERROR_CODES.CREDIT_LIMIT_EXCEEDED))).toBe(false);
    expect(predicate!(refusal(409))).toBe(false);
    expect(predicate!(refusal(500, API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED))).toBe(false);
    expect(predicate!(new Error("network"))).toBe(false);
  });

  it("the global handler stays quiet for the predicate's refusals and toasts any other", async () => {
    const meta = await metaOf(() => useVoidPayment());
    const toast = jest.fn();
    const router = { push: jest.fn() };
    handleMutationError(
      refusal(409, API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED),
      { meta },
      toast,
      router,
    );
    expect(toast).not.toHaveBeenCalled();
    handleMutationError(refusal(500), { meta }, toast, router);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("the bookkeeping invoice page's useRecordPayment() does not opt out: the global toast is its only one", async () => {
    expect(await metaOf(() => useRecordPayment())).toBeUndefined();
  });

  it("useRejectPaymentRequest is untouched (a reject writes no money)", async () => {
    expect(await metaOf(() => useRejectPaymentRequest())).toBeUndefined();
  });
});
