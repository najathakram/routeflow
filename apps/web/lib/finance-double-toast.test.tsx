import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { handleMutationError } from "./mutation-error-toast";
import { useRecordPaymentStandalone } from "./api/invoices";
import { useApprovePaymentRequest, useRejectPaymentRequest } from "./api/payment-requests";
import { useBulkCreateExpenses, useCreateExpense } from "./api/finance";
import { useDownloadInvoice, useRecordPayment } from "./api/bookkeeping";

/**
 * Rows 348 / 353 (PK-9): a finance page that renders a failed save in its OWN toast must not also get the app-wide
 * generic toast. Each mutation below is the one its page toasts for EVERY failure, so it opts out of the global
 * handler entirely (`meta.localErrorToast`), not only for a closed day. The wiring is the real MutationCache handler
 * (app/providers.tsx) over a failing 500.
 */
const fail500 = Object.assign(new Error("Request failed with status code 500"), {
  response: { status: 500, data: { message: "boom" } },
});
jest.mock("./api-client", () => ({
  apiClient: {
    get: jest.fn(() => Promise.reject(fail500)),
    post: jest.fn(() => Promise.reject(fail500)),
    patch: jest.fn(() => Promise.reject(fail500)),
    put: jest.fn(() => Promise.reject(fail500)),
    delete: jest.fn(() => Promise.reject(fail500)),
  },
}));

const globalToast = jest.fn();
const Wrapper = ({ children }: { children: React.ReactNode }) => {
  const client = React.useRef(
    new QueryClient({
      mutationCache: new MutationCache({
        onError: (error, _v, _c, mutation) =>
          handleMutationError(error, mutation, globalToast, { push: jest.fn() }),
      }),
    }),
  ).current;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const run = async <T,>(useHook: () => { mutateAsync: (v: never) => Promise<T> }, vars: unknown) => {
  const { result } = renderHook(useHook, { wrapper: Wrapper });
  await act(async () => {
    await result.current.mutateAsync(vars as never).catch(() => undefined);
  });
  await waitFor(() => undefined);
};

describe("finance pages: a failure the page toasts itself is not toasted twice (rows 348/353)", () => {
  beforeEach(() => globalToast.mockClear());

  it.each([
    [
      "useRecordPaymentStandalone",
      () => useRecordPaymentStandalone(),
      { totalAmount: 5, method: "CASH", allocations: [] },
    ],
    ["useApprovePaymentRequest", () => useApprovePaymentRequest(), "pr-1"],
    ["useRejectPaymentRequest", () => useRejectPaymentRequest(), { id: "pr-1" }],
    [
      "useCreateExpense({ localErrorToast: true })",
      () => useCreateExpense({ localErrorToast: true }),
      { amount: 1 },
    ],
    [
      "useBulkCreateExpenses({ localErrorToast: true })",
      () => useBulkCreateExpenses({ localErrorToast: true }),
      [],
    ],
    [
      "useDownloadInvoice({ localErrorToast: true })",
      () => useDownloadInvoice({ localErrorToast: true }),
      "t-1",
    ],
    [
      "useRecordPayment({ localErrorToast: true })",
      () => useRecordPayment({ localErrorToast: true }),
      { id: "t-1", amount: 1, method: "CASH" },
    ],
  ])("%s: a 500 reaches no global toast", async (_name, useHook, vars) => {
    await run(useHook as never, vars);
    expect(globalToast).not.toHaveBeenCalled();
  });

  it("control: a hook with no opt-out still gets the global toast (the handler really is wired)", async () => {
    await run(() => useCreateExpense() as never, { amount: 1 });
    expect(globalToast).toHaveBeenCalledTimes(1);
  });
});
