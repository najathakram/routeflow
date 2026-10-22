import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
  PAYMENT_PHOTO_LATER_COPY,
} from "@routeflow/types/payment-submit-key";
import InvoiceDetailPage from "./page";

/**
 * SA-824 (SA conditions a/b + race ruling 5): the invoice page's Record Payment dialog. After an unknown
 * outcome it offers "Check payment status" (POST .../by-key/:key/resolve) before any new attempt, Record is off
 * meanwhile, and a Cancel -> reopen keeps the same key. Found closes like a 2xx (and attaches the proof photo);
 * a tombstone releases the key; a 404, PAYMENT_KEY_IN_FLIGHT or any other error stays locked. A Save refused
 * 409 PAYMENT_KEY_RESOLVED releases the key with the ruling's copy. The REAL payment hooks run.
 */
const mockToast = jest.fn();
const mockPost = jest.fn();
const mockGet = jest.fn();
const mockResolve = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ id: "inv-1" }),
  usePathname: () => "/invoices/inv-1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    // the by-key resolve is its own mock so the payment POSTs keep their call indices
    post: (url: string, ...a: unknown[]) =>
      url.includes("/payments/by-key/") ? mockResolve(url, ...a) : mockPost(url, ...a),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/api/invoices", () => {
  const actual = jest.requireActual("@/lib/api/invoices");
  const idle = () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
  });
  const hooks: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    if (/^use[A-Z]/.test(key)) hooks[key] = idle;
  }
  return {
    ...actual,
    ...hooks,
    useRecordInvoicePayment: actual.useRecordInvoicePayment, // REAL: the key header + settle
    useUploadPaymentImage: actual.useUploadPaymentImage, // REAL: the proof photo upload
    useInvoice: () => ({
      data: {
        id: "inv-1",
        invoiceNumber: "INV-0014",
        status: "SENT",
        total: "100.00",
        paidAmount: "0.00",
        balanceDue: "100.00",
        issueDate: "2026-09-01T00:00:00.000Z",
        customerId: "c1",
        customer: { id: "c1", businessName: "Acme Foods" },
        items: [],
        payments: [],
      },
      isLoading: false,
      isError: false,
    }),
  };
});
jest.mock("@/lib/api/tracked-categories", () => ({ useTrackedCategories: () => ({ data: [] }) }));
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useUnapplyCreditNote: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomerAdvancePayments: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/lib/use-duplicate-invoice-action", () => ({
  useDuplicateInvoiceAction: () => ({ duplicate: jest.fn() }),
}));

const httpErr = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), { response: { status, data } });
const keyOf = (call: unknown[]) =>
  ((call[2] as { headers: Record<string, string> }).headers as Record<string, string>)[
    "Idempotency-Key"
  ];
const resolveUrl = (key: string) => `/invoices/payments/by-key/${encodeURIComponent(key)}/resolve`;
const RESOLVED_COPY =
  "This payment attempt was cancelled — nothing was charged. Start a new payment.";

// the sidebar / banner Button (the toolbar trigger is a dropdown)
const openDialog = () =>
  fireEvent.click(
    screen
      .getAllByRole("button", { name: "Record Payment" })
      .find((b) => b.hasAttribute("aria-busy"))!,
  );
const form = () => document.getElementById("invoice-payment-form") as HTMLFormElement | null;
const record = () =>
  document.querySelector<HTMLButtonElement>('button[form="invoice-payment-form"]')!;
const checkBtn = () => screen.getByRole("button", { name: "Check payment status" });
const goUnknown = async () => {
  mockPost.mockRejectedValueOnce(httpErr(503));
  renderWithProviders(<InvoiceDetailPage />);
  openDialog();
  fireEvent.click(record());
  await screen.findByRole("button", { name: "Check payment status" });
};

describe("invoices/[id] Record Payment: Check payment status (SA-824)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
    seedSession("OPERATOR");
    mockGet.mockResolvedValue({ data: {} });
    mockResolve.mockResolvedValue({ data: {} });
  });
  afterEach(() => seedSession(null));

  it("an unknown outcome offers the check and disables Record", async () => {
    await goUnknown();
    expect(record()).toBeDisabled();
  });

  it("found: closes like a 2xx, the read is by the held key, and the proof photo is attached", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    renderWithProviders(<InvoiceDetailPage />);
    openDialog();
    fireEvent.change(form()!.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["x"], "check.png", { type: "image/png" })] },
    });
    fireEvent.click(record());
    await screen.findByRole("button", { name: "Check payment status" });
    const sent = keyOf(mockPost.mock.calls[0]);
    mockResolve.mockResolvedValue({
      data: { state: "found", scope: "INVOICE_PAYMENT", id: "inv-1", createdPaymentId: "p7" },
    });
    mockPost.mockResolvedValue({ data: { url: "u" } });
    fireEvent.click(checkBtn());
    await waitFor(() => expect(form()).toBeNull());
    expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent));
    expect(mockPost.mock.calls.map((c) => c[0])).toContain("/invoices/payments/p7/image");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This payment was recorded." }),
    );
  });

  it("found with no createdPaymentId: the fixed 'add the photo' copy, nothing uploaded", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    renderWithProviders(<InvoiceDetailPage />);
    openDialog();
    fireEvent.change(form()!.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["x"], "check.png", { type: "image/png" })] },
    });
    fireEvent.click(record());
    await screen.findByRole("button", { name: "Check payment status" });
    mockResolve.mockResolvedValue({
      data: { state: "found", scope: "INVOICE_PAYMENT", id: "inv-1", payments: [{ id: "old" }] },
    });
    fireEvent.click(checkBtn());
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: PAYMENT_PHOTO_LATER_COPY }),
      ),
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("tombstoned: released with the ruling's copy, Record is back, the next attempt has a NEW key", async () => {
    await goUnknown();
    const first = keyOf(mockPost.mock.calls[0]);
    mockResolve.mockResolvedValue({ data: { state: "tombstoned" } });
    fireEvent.click(checkBtn());
    expect(await screen.findByText(RESOLVED_COPY)).toBeTruthy();
    expect(record()).not.toBeDisabled();
    mockPost.mockRejectedValueOnce(httpErr(400));
    fireEvent.click(record());
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(first);
  });

  it("a 404 (even PAYMENT_KEY_NOT_FOUND) never releases (race ruling 5): still unknown, Record stays off", async () => {
    await goUnknown();
    mockResolve.mockRejectedValue(
      httpErr(404, { code: "PAYMENT_KEY_NOT_FOUND", message: "RAW SERVER TEXT" }),
    );
    fireEvent.click(checkBtn());
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing was recorded. You can try again.")).toBeNull();
    expect(record()).toBeDisabled();
    expect(checkBtn()).toBeTruthy();
  });

  it("409 PAYMENT_KEY_IN_FLIGHT: the fixed retry copy, still unknown, the check still offered", async () => {
    await goUnknown();
    mockResolve.mockRejectedValue(
      httpErr(409, { code: "PAYMENT_KEY_IN_FLIGHT", message: "RAW SERVER TEXT" }),
    );
    fireEvent.click(checkBtn());
    expect(
      await screen.findByText(
        "This payment is still being recorded. Check its status again in a moment.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(record()).toBeDisabled();
    expect(checkBtn()).toBeTruthy();
  });

  it("a Save refused 409 PAYMENT_KEY_RESOLVED: the ruling's copy, the key released, the next Save has a NEW key", async () => {
    mockPost.mockRejectedValueOnce(
      httpErr(409, { code: "PAYMENT_KEY_RESOLVED", message: "RAW SERVER TEXT" }),
    );
    renderWithProviders(<InvoiceDetailPage />);
    openDialog();
    fireEvent.click(record());
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: RESOLVED_COPY }),
      ),
    );
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
    expect(record()).not.toBeDisabled();
    const first = keyOf(mockPost.mock.calls[0]);
    mockPost.mockRejectedValueOnce(httpErr(400));
    fireEvent.click(record());
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(first);
  });

  it("error: the fixed copy (never the raw message), still unknown, Record stays off", async () => {
    await goUnknown();
    mockResolve.mockRejectedValue(httpErr(500, { message: "RAW SERVER TEXT" }));
    fireEvent.click(checkBtn());
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(record()).toBeDisabled();
    expect(checkBtn()).toBeTruthy();
  });

  it("Cancel -> reopen after an unknown outcome: the same key, Record still off, the check still offered", async () => {
    await goUnknown();
    const sent = keyOf(mockPost.mock.calls[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(form()).toBeNull());
    openDialog();
    expect(checkBtn()).toBeTruthy();
    expect(record()).toBeDisabled();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent)));
  });

  it("submitting the form while unknown (Enter) sends nothing", async () => {
    await goUnknown();
    fireEvent.submit(form()!);
    await Promise.resolve();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("the submit handler re-checks the unknown lock when it lands after the last render", async () => {
    renderWithProviders(<InvoiceDetailPage />);
    openDialog();
    const holder = acquirePaymentKeyHolder("invoice:inv-1");
    holder.keyFor({ amount: 100, method: "ACH" });
    holder.settle(holder.peek()!, { ok: false, error: httpErr(503) });
    expect(record()).not.toBeDisabled();
    fireEvent.click(record());
    await Promise.resolve();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
