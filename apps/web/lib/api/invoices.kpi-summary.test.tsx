/**
 * REG-B11 (F16 hotfix, K1b) — the invoices page's KPI bar must REFRESH after a
 * payment mutation, not merely be computed correctly.
 *
 * B12 moved the six tiles off `useInvoices({ limit: 999 })` + a client reduce
 * and onto a server query of its own (`useInvoiceKpiSummary`). The list query
 * was refetched by every `invalidateQueries({ queryKey: ["invoices"] })` in
 * this module, so the tiles came along for free; a summary query keyed OUTSIDE
 * that prefix would silently stop doing so and leave the "Awaiting
 * Confirmation" tile stale until a full reload.
 *
 * Pinned behaviourally — through a REAL QueryClient, never by eyeballing the
 * key literal — so a future re-key (`["invoice-kpis", …]`, a `["kpi", …]`
 * namespace) or a mutation that stops invalidating `["invoices"]` fails here
 * rather than in a post-deploy E2E.
 */
import * as React from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import {
  useInvoiceKpiSummary,
  useRecordInvoicePayment,
  useUpdateInvoicePayment,
  useVoidPayment,
  useRecordPaymentStandalone,
} from "./invoices";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;
const mockedPost = apiClient.post as jest.Mock;
const mockedPatch = apiClient.patch as jest.Mock;

const TODAY = "2026-09-07";
const SUMMARY = {
  totalOutstanding: 0,
  overdue: 0,
  dueToday: 0,
  dueIn30: 0,
  avgDays: 0,
  awaitingConfirmationCount: 2,
};

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** How many times the SUMMARY endpoint has been read (other GETs don't count). */
const summaryReads = () =>
  mockedGet.mock.calls.filter((c) => c[0] === "/invoices/kpi-summary").length;

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockResolvedValue({ data: SUMMARY });
  mockedPost.mockResolvedValue({ data: { id: "inv-1", payments: [], paymentGroupId: "g1" } });
  mockedPatch.mockResolvedValue({ data: { id: "inv-1", success: true } });
});

describe("useInvoiceKpiSummary — refresh on payment mutations (REG-B11 / K1b)", () => {
  it("reads GET /invoices/kpi-summary with the viewer's own calendar day", async () => {
    const { result } = renderHook(() => useInvoiceKpiSummary(TODAY), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedGet).toHaveBeenCalledWith("/invoices/kpi-summary", { params: { today: TODAY } });
    expect(result.current.data?.awaitingConfirmationCount).toBe(2);
  });

  it("refetches the summary after a payment is recorded on an invoice", async () => {
    const { result } = renderHook(
      () => ({ summary: useInvoiceKpiSummary(TODAY), record: useRecordInvoicePayment() }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.summary.isSuccess).toBe(true));
    expect(summaryReads()).toBe(1);

    await act(async () => {
      await result.current.record.mutateAsync({
        id: "inv-1",
        amount: 200,
        method: "ACH",
        status: "DRAFT",
      });
    });

    // The E2E's exact scenario: recording a DRAFT payment must move the
    // "Awaiting Confirmation" tile without a reload.
    await waitFor(() => expect(summaryReads()).toBe(2));
  });

  it("refetches the summary after a payment is updated, voided, or recorded standalone", async () => {
    const { result } = renderHook(
      () => ({
        summary: useInvoiceKpiSummary(TODAY),
        update: useUpdateInvoicePayment(),
        voidPayment: useVoidPayment(),
        standalone: useRecordPaymentStandalone(),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.summary.isSuccess).toBe(true));

    const fires: Array<() => Promise<unknown>> = [
      () =>
        result.current.update.mutateAsync({
          invoiceId: "inv-1",
          paymentId: "pay-1",
          method: "CASH",
          amount: 100,
        }),
      () => result.current.voidPayment.mutateAsync({ invoiceId: "inv-1", paymentId: "pay-1" }),
      () =>
        result.current.standalone.mutateAsync({
          customerId: "cust-1",
          totalAmount: 100,
          method: "CASH",
          allocations: [{ invoiceId: "inv-1", amount: 100 }],
        }),
    ];

    for (const fire of fires) {
      const before = summaryReads();
      await act(async () => {
        await fire();
      });
      await waitFor(() => expect(summaryReads()).toBe(before + 1));
    }
  });
});
