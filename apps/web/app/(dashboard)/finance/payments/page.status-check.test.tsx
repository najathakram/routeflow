import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
  PAYMENT_PHOTO_LATER_COPY,
} from "@routeflow/types/payment-submit-key";
import FinancePaymentsPage from "./page";

/**
 * SA-824 (SA conditions a/b): the Payments page's Record Payment dialog. After an unknown outcome it
 * offers "Check payment status" (a GET by key) before any new attempt, Save is off meanwhile, and a
 * Cancel -> reopen keeps the same key. Found closes like a 2xx (and attaches the proof photo); a 404
 * PAYMENT_KEY_NOT_FOUND releases the key; any other error stays locked.
 */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/finance/payments",
  useSearchParams: () => new URLSearchParams(),
}));
const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
  },
}));

const httpErr = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), { response: { status, data } });
const keyOf = (call: unknown[]) =>
  ((call[2] as { headers: Record<string, string> }).headers as Record<string, string>)[
    "Idempotency-Key"
  ];
const list = { data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 1 } } };
const byKey = (answer: () => unknown) => async (url: string) => {
  if (url.includes("/payments/by-key/")) return answer();
  if (url.startsWith("/customers")) {
    return { data: { data: [{ id: "cust-1", businessName: "Acme Foods" }], meta: {} } };
  }
  return list;
};

async function openModal() {
  renderWithProviders(<FinancePaymentsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
  await screen.findAllByRole("option", { name: /Acme Foods/ });
  fireEvent.change(screen.getByDisplayValue("Select customer..."), {
    target: { value: "cust-1" },
  });
  fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));
const checkBtn = () => screen.getByRole("button", { name: "Check payment status" });
const goUnknown = async () => {
  mockPost.mockRejectedValueOnce(httpErr(503));
  await openModal();
  save();
  await screen.findByRole("button", { name: "Check payment status" });
};

describe("finance/payments Record Payment: Check payment status (SA-824)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
    mockGet.mockImplementation(byKey(() => ({ data: {} })));
  });

  it("an unknown outcome offers the check and disables both Save buttons", async () => {
    await goUnknown();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeDisabled();
  });

  it("found: closes like a 2xx, the read is by the held key, and the proof photo is attached", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    await openModal();
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["x"], "check.png", { type: "image/png" })] },
    });
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    const sent = keyOf(mockPost.mock.calls[0]);
    mockGet.mockImplementation(
      byKey(() => ({
        data: { scope: "STANDALONE_PAYMENT", paymentGroupId: "g1", payments: [{ id: "p1" }] },
      })),
    );
    mockPost.mockResolvedValue({ data: { url: "u" } });
    fireEvent.click(checkBtn());
    await waitFor(() => expect(screen.queryByText("Record Payment")).toBeNull());
    expect(mockGet).toHaveBeenCalledWith(`/invoices/payments/by-key/${encodeURIComponent(sent)}`);
    expect(mockPost.mock.calls.map((c) => c[0])).toContain("/invoices/payments/p1/image");
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This payment was recorded." }),
    );
  });

  it("found with no derivable payment id: the fixed 'add the photo' copy, nothing uploaded", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    await openModal();
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["x"], "check.png", { type: "image/png" })] },
    });
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    mockGet.mockImplementation(
      byKey(() => ({ data: { scope: "STANDALONE_PAYMENT", paymentGroupId: "g1", payments: [] } })),
    );
    fireEvent.click(checkBtn());
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: PAYMENT_PHOTO_LATER_COPY }),
      ),
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("not found (404 PAYMENT_KEY_NOT_FOUND): released, Save is back, the next attempt has a NEW key", async () => {
    await goUnknown();
    const first = keyOf(mockPost.mock.calls[0]);
    mockGet.mockImplementation(
      byKey(() => {
        throw httpErr(404, { code: "PAYMENT_KEY_NOT_FOUND", message: "RAW SERVER TEXT" });
      }),
    );
    fireEvent.click(checkBtn());
    expect(await screen.findByText("Nothing was recorded. You can try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).not.toBeDisabled();
    mockPost.mockRejectedValueOnce(httpErr(400));
    save();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(first);
  });

  it("error: the fixed copy (never the raw message), still unknown, Save stays off", async () => {
    await goUnknown();
    mockGet.mockImplementation(
      byKey(() => {
        throw httpErr(500, { message: "RAW SERVER TEXT" });
      }),
    );
    fireEvent.click(checkBtn());
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(checkBtn()).toBeTruthy();
  });

  it("Cancel -> reopen after an unknown outcome: the same key, Save still off, the check still offered", async () => {
    await goUnknown();
    const sent = keyOf(mockPost.mock.calls[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
    expect(checkBtn()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    fireEvent.click(checkBtn());
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(`/invoices/payments/by-key/${encodeURIComponent(sent)}`),
    );
  });

  it("the submit handler re-checks the unknown lock (not only the disabled prop)", async () => {
    await openModal();
    const holder = acquirePaymentKeyHolder("standalone:payments-page");
    holder.keyFor({ amount: 50, method: "CASH" });
    holder.settle({ ok: false, error: httpErr(503) });
    expect(screen.getByRole("button", { name: "Save as Paid" })).not.toBeDisabled();
    save();
    await Promise.resolve();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
