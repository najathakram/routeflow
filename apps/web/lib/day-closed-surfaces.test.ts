import * as React from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { API_ERROR_CODES } from "@routeflow/types";
import {
  COUNTER_SALE_DAY_CLOSED_COPY,
  DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
  REFUND_DAY_CLOSED_COPY,
  dayClosedCopy,
  isDayClosedRefusal,
} from "./day-closed-copy";
import { COUNTER_VOID_ERROR_COPY } from "./counter-void-copy";
import { counterVoidErrorCopy } from "./counter-void-error";
import {
  COUNTER_SALE_DAY_CLOSED_TILL_COPY,
  PICKUP_DAY_CLOSED_COPY,
  counterSaleErrorCopy,
  isDefinitiveCounterSaleRefusal,
  isPickupHandledError,
  pickupCompleteErrorCopy,
} from "./counter-sale";
import { refundErrorMessage } from "./credit-note-error-copy";
import { codedToastCopy, genericToastCopy } from "./generic-toast-copy";
import { handleMutationError } from "./mutation-error-toast";
import { REFUND_COPY, refundErrorKind } from "../app/(dashboard)/returns/_components/refund-copy";
import { apiClient } from "./api-client";
import {
  useDeleteInvoicePayment,
  useRecordInvoicePayment,
  useSetCheckStatus,
  useUpdateInvoicePayment,
} from "./api/invoices";
import { useProcessRefund } from "./api/returns";

jest.mock("./api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

/**
 * SA-750r3: the one table of every web surface that can receive an end-of-day close refusal (409 COUNTER_SALE_DAY_CLOSED /
 * DAY_CLOSED_FOR_PAYMENT_DATE) and the FIXED sentence each one shows. No surface may fall to the generic "That conflicts
 * with something..." line, and none may show the server's text.
 */
const RAW = "RAW SERVER TEXT: closed through 2026-10-09";
const refusal = (code: string, status = 409) => ({
  response: { status, data: { code, message: RAW, closedThrough: "2026-10-09T05:00:00.000Z" } },
});
const COUNTER = refusal(API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED);
const PAYMENT_DATE = refusal(API_ERROR_CODES.DAY_CLOSED_FOR_PAYMENT_DATE);
const GENERIC_CONFLICT =
  "That conflicts with something that already exists or is in use. Check it and try again.";

/** [surface, how it reaches the copy, refusal, expected sentence] */
const SURFACES: ReadonlyArray<readonly [string, (e: unknown) => string, unknown, string]> = [
  // The Void dialog (CounterVoidSaleDialog): a sale rung before the close, or a tender dated inside a closed day.
  [
    "Void sale dialog",
    counterVoidErrorCopy,
    COUNTER,
    "This sale is in a closed day and can't be voided. Use Return items instead.",
  ],
  // The pickup hand-over dialog: the hand-over stands, only the payment was refused.
  [
    "Pickup hand-over dialog",
    pickupCompleteErrorCopy,
    COUNTER,
    "Handed over. Payment is still due.",
  ],
  // The till's own checkout: the sale is saved, only its tender was refused.
  [
    "Counter sale checkout (till)",
    counterSaleErrorCopy,
    COUNTER,
    "This day is closed, so no payment was taken. The sale is saved without payment.",
  ],
  // The invoice page: record / edit / delete a payment, a check-status change (all four read dayClosedCopy).
  [
    "Invoice page: record, edit, delete payment, check status (till write)",
    (e) => dayClosedCopy(e) ?? "",
    COUNTER,
    "This day is closed, so this can't be changed. Record it with today's date instead.",
  ],
  [
    "Invoice page: record / edit payment (payment date)",
    (e) => dayClosedCopy(e) ?? "",
    PAYMENT_DATE,
    "That day is closed. Record it with today's date.",
  ],
  // The returns page refund and the inline refund dialog.
  [
    "Return page refund toast",
    (e) => refundErrorMessage(e, "otherwise") ?? "",
    COUNTER,
    "This day is closed, so the refund can't be recorded now. Give store credit instead, or record the refund on a later date.",
  ],
  [
    "Inline return dialog refund",
    (e) => REFUND_COPY[refundErrorKind(e)],
    COUNTER,
    "Return saved. This day is closed, so the refund can't be paid out now. Give store credit instead, or record the refund on a later date.",
  ],
  // The global fallback (any dialog without copy of its own: void payment, bookkeeping payment, finance reports).
  ["Global toast fallback (till write)", genericToastCopy, COUNTER, COUNTER_SALE_DAY_CLOSED_COPY],
  [
    "Global toast fallback (payment date)",
    genericToastCopy,
    PAYMENT_DATE,
    DAY_CLOSED_FOR_PAYMENT_DATE_COPY,
  ],
  [
    "codedToastCopy (till write)",
    (e) => codedToastCopy(e) ?? "",
    COUNTER,
    COUNTER_SALE_DAY_CLOSED_COPY,
  ],
];

describe("every surface that can receive an end-of-day close refusal shows fixed, fitting copy", () => {
  it.each(SURFACES)("%s", (_surface, copyOf, err, expected) => {
    const copy = copyOf(err);
    expect(copy).toBe(expected);
    expect(copy).not.toContain("RAW SERVER TEXT");
    expect(copy).not.toBe(GENERIC_CONFLICT);
    expect(copy).not.toMatch(/conflicts with something/i);
  });

  it("the sentences are the ones the helpers export (no drift between a constant and its use)", () => {
    expect(COUNTER_VOID_ERROR_COPY[API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED]).toBe(
      "This sale is in a closed day and can't be voided. Use Return items instead.",
    );
    expect(PICKUP_DAY_CLOSED_COPY).toBe("Handed over. Payment is still due.");
    expect(COUNTER_SALE_DAY_CLOSED_TILL_COPY).toMatch(/^This day is closed/);
    expect(REFUND_DAY_CLOSED_COPY).toMatch(/store credit/);
  });

  it("the global MutationCache handler shows the fixed sentence for both codes (an unmapped dialog never gets the generic line)", () => {
    for (const [err, expected] of [
      [COUNTER, COUNTER_SALE_DAY_CLOSED_COPY],
      [PAYMENT_DATE, DAY_CLOSED_FOR_PAYMENT_DATE_COPY],
    ] as const) {
      const toast = jest.fn();
      handleMutationError(err, { meta: undefined }, toast, { push: jest.fn() });
      expect(toast).toHaveBeenCalledWith({ title: expected, variant: "error" });
    }
  });

  it("only a 409 with a day-close code is a day-close refusal", () => {
    expect(isDayClosedRefusal(COUNTER)).toBe(true);
    expect(isDayClosedRefusal(PAYMENT_DATE)).toBe(true);
    expect(isDayClosedRefusal(refusal(API_ERROR_CODES.COUNTER_SALE_DAY_CLOSED, 400))).toBe(false);
    expect(isDayClosedRefusal(refusal(API_ERROR_CODES.COUNTER_SALE_VOIDED))).toBe(false);
    expect(isDayClosedRefusal(null)).toBe(false);
    expect(isDayClosedRefusal(new Error("Network Error"))).toBe(false);
  });

  it("the till checkout treats the refusal as a sale that EXISTS (never a fresh key); the pickup dialog owns its copy", () => {
    expect(isDefinitiveCounterSaleRefusal(COUNTER)).toBe(false);
    expect(isPickupHandledError(COUNTER)).toBe(true);
  });
});

describe("the web payment / refund hooks keep the global toast quiet for a day-close refusal (the page says it)", () => {
  const cases: ReadonlyArray<
    readonly [string, () => { mutateAsync: (v: never) => Promise<unknown> }, unknown]
  > = [
    ["useRecordInvoicePayment", useRecordInvoicePayment, { id: "i1", method: "CASH", amount: 1 }],
    [
      "useUpdateInvoicePayment",
      useUpdateInvoicePayment,
      { invoiceId: "i1", paymentId: "p1", method: "CASH", amount: 1 },
    ],
    ["useDeleteInvoicePayment", useDeleteInvoicePayment, { invoiceId: "i1", paymentId: "p1" }],
    [
      "useSetCheckStatus",
      useSetCheckStatus,
      { invoiceId: "i1", paymentId: "p1", status: "DEPOSITED", nsfFeeAmount: 0 },
    ],
    ["useProcessRefund", useProcessRefund, { id: "r1", method: "EXTERNAL_REFUND" }],
  ] as never;

  it.each(cases)("%s", async (_name, useHook, vars) => {
    for (const fn of [apiClient.post, apiClient.patch, apiClient.delete])
      (fn as jest.Mock).mockRejectedValue(COUNTER);
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useHook(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(vars as never).catch(() => undefined);
    });
    const meta = qc.getMutationCache().getAll()[0].meta as {
      localErrorToast: (e: unknown) => boolean;
    };
    expect(meta.localErrorToast(COUNTER)).toBe(true);
    expect(meta.localErrorToast(PAYMENT_DATE)).toBe(true);
    expect(meta.localErrorToast(refusal("SOMETHING_ELSE"))).toBe(false);
    expect(meta.localErrorToast(new Error("Network Error"))).toBe(false);
  });
});
