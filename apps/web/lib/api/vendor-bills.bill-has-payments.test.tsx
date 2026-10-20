/**
 * B288 (SA-814 R5-3): a void / revert / delete refused with 409 BILL_HAS_PAYMENTS shows FIXED copy built
 * from the structured `amount` (never the server's message), and the exit — "Move to supplier credit" —
 * posts to the move-to-credit endpoint and is offered only for cash payments.
 */
import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { codedToastCopy } from "@/lib/generic-toast-copy";
import {
  isMovableBillPayment,
  useMoveVendorBillPaymentToCredit,
  voidFailureToast,
} from "./vendor-bills";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
const mockedPost = apiClient.post as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => jest.clearAllMocks());

const COPY = "This bill has $200.00 in payments. Move them to a supplier credit first.";
const refusal = (data: Record<string, unknown>) => ({
  response: {
    status: 409,
    data: { code: "BILL_HAS_PAYMENTS", message: "raw server text", ...data },
  },
});

describe("BILL_HAS_PAYMENTS copy", () => {
  it("is the fixed sentence with the structured amount", () => {
    expect(codedToastCopy(refusal({ amount: 200 }))).toBe(COPY);
    expect(codedToastCopy(refusal({ amount: 1234.5 }))).toBe(
      "This bill has $1234.50 in payments. Move them to a supplier credit first.",
    );
  });

  it("never renders the server's message, and degrades without a usable amount", () => {
    expect(codedToastCopy(refusal({ amount: 200 }))).not.toContain("raw server text");
    for (const amount of [undefined, "200", -5, Number.NaN, null]) {
      expect(codedToastCopy(refusal({ amount }))).toBe(
        "This bill has payments. Move them to a supplier credit first.",
      );
    }
  });

  it("is what a refused void toasts", () => {
    expect(voidFailureToast(refusal({ amount: 200 }))).toEqual({
      title: "Failed to void bill",
      description: COPY,
      variant: "error",
    });
  });
});

describe("move to supplier credit", () => {
  it("is offered for cash payments only, never for a credit draw", () => {
    expect(isMovableBillPayment({ method: "CHECK", supplierCreditId: null })).toBe(true);
    expect(isMovableBillPayment({ method: "CASH" })).toBe(true);
    expect(isMovableBillPayment({ method: "CREDIT_NOTE", supplierCreditId: "credit-1" })).toBe(
      false,
    );
    expect(isMovableBillPayment({ method: "CHECK", supplierCreditId: "credit-1" })).toBe(false);
  });

  it("posts to the move-to-credit endpoint and opts out of the app-wide error toast", async () => {
    mockedPost.mockResolvedValue({ data: { bill: { id: "bill-1" } } });
    const qc = createTestQueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMoveVendorBillPaymentToCredit(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ billId: "bill-1", paymentId: "pay-1" });
    });
    expect(mockedPost).toHaveBeenCalledWith("/vendor-bills/bill-1/payments/pay-1/move-to-credit");
    expect(qc.getMutationCache().getAll()[0]?.meta).toEqual({ localErrorToast: true });
  });

  it("invalidates the real supplier statement / credit keys, not a dead one", async () => {
    mockedPost.mockResolvedValue({ data: { bill: { id: "bill-1" } } });
    const qc = createTestQueryClient();
    const spy = jest.spyOn(qc, "invalidateQueries");
    qc.setQueryData(["suppliers", "s1", "statement"], { timeline: [] });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMoveVendorBillPaymentToCredit(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ billId: "bill-1", paymentId: "pay-1" });
    });
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
    expect(keys).toContainEqual(["suppliers"]);
    expect(keys).not.toContainEqual(["supplier-statement"]);
    // ["suppliers"] is a prefix of the statement query ["suppliers", id, "statement"].
    expect(qc.getQueryState(["suppliers", "s1", "statement"])?.isInvalidated).toBe(true);
  });
});
