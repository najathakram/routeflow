/**
 * B76: an invoice money mutation (a payment recorded, edited, deleted or voided; a credit note or advance
 * applied; a write-off; a status change) used to invalidate only the `["invoices"]` keys. The order page's
 * invoice badge reads `order.invoices`, so it stayed on the old status and balance until a reload.
 * `invalidateInvoiceMoney` is the one helper that also refreshes `["orders"]`.
 *
 * Behavioural: every case runs the real mutation hook against a real QueryClient and asserts what its
 * `onSuccess` invalidated. The inventory at the bottom reads invoices.ts and fails when a new mutation
 * invalidates the invoice keys without the helper (and without an allowlist reason).
 */
import * as React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderHook, act } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import * as invoicesApi from "./invoices";
import {
  invalidateInvoiceMoney,
  useAdjustInvoicePrices,
  useApplyAdvanceToInvoice,
  useApplyCreditNote,
  useDeleteInvoice,
  useDeleteInvoicePayment,
  useRecordInvoicePayment,
  useRecordPaymentStandalone,
  useReopenInvoice,
  useRevertInvoiceToDraft,
  useSendInvoice,
  useSendInvoiceEmail,
  useSetCheckStatus,
  useUnvoidInvoice,
  useUpdateInvoice,
  useUpdateInvoicePayment,
  useUpdateInvoiceTerms,
  useVoidInvoice,
  useVoidPayment,
  useWriteOffInvoice,
} from "./invoices";
import { useApplyCreditNote as useApplyCreditNoteFromNote } from "./credit-notes";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const INVOICE = { id: "inv-1", payments: [], paymentGroupId: "g1", success: true };

beforeEach(() => {
  jest.clearAllMocks();
  for (const verb of ["get", "post", "patch", "delete"] as const) {
    (apiClient[verb] as jest.Mock).mockResolvedValue({ data: INVOICE });
  }
});

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** [label, hook, the mutation's variables] for every mutation that changes an invoice's status or balance. */
const CASES: Array<[string, () => { mutateAsync: (v: any) => Promise<unknown> }, unknown]> = [
  ["record payment", useRecordInvoicePayment, { id: "inv-1", amount: 10, method: "CASH" }],
  [
    "update payment",
    useUpdateInvoicePayment,
    { invoiceId: "inv-1", paymentId: "p-1", method: "CASH", amount: 5 },
  ],
  ["delete payment", useDeleteInvoicePayment, { invoiceId: "inv-1", paymentId: "p-1" }],
  [
    "record standalone payment",
    useRecordPaymentStandalone,
    {
      customerId: "c-1",
      totalAmount: 10,
      method: "CASH",
      allocations: [{ invoiceId: "inv-1", amount: 10 }],
    },
  ],
  ["void payment", useVoidPayment, { invoiceId: "inv-1", paymentId: "p-1" }],
  [
    "set check status",
    useSetCheckStatus,
    { invoiceId: "inv-1", paymentId: "p-1", checkStatus: "CLEARED" },
  ],
  ["apply credit note", useApplyCreditNote, { creditNoteId: "cn-1", invoiceId: "inv-1" }],
  [
    "apply advance",
    useApplyAdvanceToInvoice,
    { customerId: "c-1", advancePaymentId: "adv-1", invoiceId: "inv-1" },
  ],
  ["write off", useWriteOffInvoice, { id: "inv-1", reason: "uncollectible" }],
  ["reopen", useReopenInvoice, "inv-1"],
  ["revert to draft", useRevertInvoiceToDraft, "inv-1"],
  ["unvoid", useUnvoidInvoice, { id: "inv-1" }],
  ["send", useSendInvoice, "inv-1"],
  ["send email", useSendInvoiceEmail, { id: "inv-1" }],
  ["update invoice", useUpdateInvoice, { id: "inv-1", notes: "x" }],
  [
    "adjust prices",
    useAdjustInvoicePrices,
    { id: "inv-1", scope: "SINGLE", items: [{ itemId: "i-1", newUnitPrice: 3 }] },
  ],
  ["void invoice", useVoidInvoice, "inv-1"],
  ["delete invoice", useDeleteInvoice, "inv-1"],
  // The API's updateTerms recomputes the status from the new due date (OVERDUE <-> SENT) and emits no
  // invoice.updated, and the order card shows the due date.
  ["update terms", useUpdateInvoiceTerms, { id: "inv-1", dueDate: "2026-12-01" }],
  // The credit note page's apply changes the invoice balance; the API emits no invoice.updated for it.
  [
    "apply credit note (credit note page)",
    useApplyCreditNoteFromNote,
    { id: "cn-1", invoiceId: "inv-1" },
  ],
];

describe("B76: invoice money mutations refresh the orders that show the invoice", () => {
  it.each(CASES)("%s invalidates [orders] and the invoice keys", async (_label, hook, vars) => {
    const client = createTestQueryClient();
    const spy = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => hook(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync(vars);
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["invoices"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["orders"] });
  });

  it.each(
    CASES.filter(([label]) => label !== "record standalone payment" && label !== "delete invoice"),
  )("%s also invalidates the one invoice's detail key", async (_label, hook, vars) => {
    const client = createTestQueryClient();
    const spy = jest.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => hook(), { wrapper: wrapperFor(client) });

    await act(async () => {
      await result.current.mutateAsync(vars);
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["invoices", "inv-1"] });
  });
});

describe("invalidateInvoiceMoney", () => {
  it("invalidates the invoices list, the one invoice when given, and the orders", () => {
    const client = createTestQueryClient();
    const spy = jest.spyOn(client, "invalidateQueries");

    invalidateInvoiceMoney(client, "inv-9");

    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { queryKey: ["invoices"] },
      { queryKey: ["invoices", "inv-9"] },
      { queryKey: ["orders"] },
    ]);
  });

  it("without an id it skips the detail key", () => {
    const client = createTestQueryClient();
    const spy = jest.spyOn(client, "invalidateQueries");

    invalidateInvoiceMoney(client);

    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { queryKey: ["invoices"] },
      { queryKey: ["orders"] },
    ]);
  });
});

/**
 * Inventory: every mutation hook in invoices.ts that invalidates an invoice key must call the helper, unless it is
 * listed here with the reason it cannot change an invoice's status or balance. A new money mutation fails this
 * test until it calls `invalidateInvoiceMoney` (or is added with a reason).
 */
const NOT_MONEY: Record<string, string> = {
  useCreateInvoice: "creates a new DRAFT with no order link: no existing order badge changes",
  useDuplicateInvoice: "creates a new DRAFT copy: no existing order badge changes",
  useUpdateInvoiceShipment: "shipment fields only: status and balance are untouched",
  useUploadPaymentImage: "attaches an image to a payment: amount and status unchanged",
  useDeletePaymentImage: "removes an image from a payment: amount and status unchanged",
  useRunRecurringInvoice: "creates a new invoice from a template: no order is linked",
  useCreateInvoiceFromOrder: "already invalidates [orders] itself: it creates the order's invoice",
  useCreatePartialInvoiceFromOrder:
    "already invalidates [orders] itself: it creates a partial invoice",
};

describe("B76 inventory: invoice mutations that invalidate invoice keys use the shared helper", () => {
  // credit-notes.ts too: its apply and void change an invoice's balance and status.
  const src = ["invoices.ts", "credit-notes.ts"]
    .map((file) => readFileSync(join(__dirname, file), "utf8"))
    .join("\n");
  const blocks = src
    .split(/\r?\n(?=export function )/)
    .map((b) => ({ name: /^export function (\w+)/.exec(b)?.[1] ?? "", body: b }))
    .filter((b) => b.name.startsWith("use") && b.body.includes("useMutation"));
  const invalidatesInvoices = (b: { body: string }) => /queryKey:\s*\["invoices"/.test(b.body);

  it("finds the mutation hooks", () => {
    expect(blocks.length).toBeGreaterThan(20);
    expect(typeof invoicesApi.invalidateInvoiceMoney).toBe("function");
  });

  it("every invoice-invalidating mutation calls invalidateInvoiceMoney or is allowlisted with a reason", () => {
    const offenders = blocks
      .filter(invalidatesInvoices)
      .filter((b) => !b.body.includes("invalidateInvoiceMoney(") && !(b.name in NOT_MONEY))
      .map((b) => b.name);
    expect(offenders).toEqual([]);
  });

  it("the allowlist names only real invoice-invalidating mutations that do not call the helper", () => {
    for (const name of Object.keys(NOT_MONEY)) {
      const block = blocks.find((b) => b.name === name);
      expect(block).toBeDefined();
      expect(invalidatesInvoices(block!)).toBe(true);
      expect(block!.body).not.toContain("invalidateInvoiceMoney(");
      expect(NOT_MONEY[name].length).toBeGreaterThan(10);
    }
  });
});
