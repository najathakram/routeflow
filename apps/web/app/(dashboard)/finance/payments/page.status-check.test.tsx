import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
  PAYMENT_PHOTO_LATER_COPY,
} from "@routeflow/types/payment-submit-key";
import FinancePaymentsPage from "./page";

/**
 * SA-824 (SA conditions a/b + race ruling 5): the Payments page's Record Payment dialog. After an unknown
 * outcome it offers "Check payment status" (POST .../by-key/:key/resolve) before any new attempt, Save is off
 * meanwhile, and a Cancel -> reopen keeps the same key. Found closes like a 2xx (and attaches the proof
 * photo); a tombstone releases the key; a 404, PAYMENT_KEY_IN_FLIGHT or any other error stays locked. A Save
 * refused 409 PAYMENT_KEY_RESOLVED releases the key with the ruling's copy.
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
const mockResolve = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    // the by-key resolve is its own mock so the payment POSTs keep their call indices
    post: (url: string, ...a: unknown[]) =>
      url.includes("/payments/by-key/") ? mockResolve(url, ...a) : mockPost(url, ...a),
  },
}));

const httpErr = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), { response: { status, data } });
const keyOf = (call: unknown[]) =>
  ((call[2] as { headers: Record<string, string> }).headers as Record<string, string>)[
    "Idempotency-Key"
  ];
const list = { data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 1 } } };
const resolveUrl = (key: string) => `/invoices/payments/by-key/${encodeURIComponent(key)}/resolve`;
const RESOLVED_COPY =
  "This payment attempt was cancelled — nothing was charged. Start a new payment.";
const routes = async (url: string) => {
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
// the scope is the customer (writer + target): a reopened dialog resolves it when the customer is chosen
const pickCustomer = async () => {
  await screen.findAllByRole("option", { name: /Acme Foods/ });
  fireEvent.change(screen.getByDisplayValue("Select customer..."), { target: { value: "cust-1" } });
};
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
    mockGet.mockImplementation(routes);
    mockResolve.mockResolvedValue({ data: {} });
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
    mockResolve.mockResolvedValue({
      data: {
        state: "found",
        scope: "STANDALONE_PAYMENT",
        paymentGroupId: "g1",
        payments: [{ id: "p1" }],
      },
    });
    mockPost.mockResolvedValue({ data: { url: "u" } });
    fireEvent.click(checkBtn());
    await waitFor(() => expect(screen.queryByText("Record Payment")).toBeNull());
    expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent));
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
    mockResolve.mockResolvedValue({
      data: { state: "found", scope: "STANDALONE_PAYMENT", paymentGroupId: "g1", payments: [] },
    });
    fireEvent.click(checkBtn());
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: PAYMENT_PHOTO_LATER_COPY }),
      ),
    );
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("tombstoned: released with the ruling's copy, Save is back, the next attempt has a NEW key", async () => {
    await goUnknown();
    const first = keyOf(mockPost.mock.calls[0]);
    mockResolve.mockResolvedValue({ data: { state: "tombstoned" } });
    fireEvent.click(checkBtn());
    expect(await screen.findByText(RESOLVED_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).not.toBeDisabled();
    mockPost.mockRejectedValueOnce(httpErr(400));
    save();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(first);
  });

  it("a 404 (even PAYMENT_KEY_NOT_FOUND) never releases (race ruling 5): still unknown, Save stays off", async () => {
    await goUnknown();
    mockResolve.mockRejectedValue(httpErr(404, { code: "PAYMENT_KEY_NOT_FOUND" }));
    fireEvent.click(checkBtn());
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
  });

  it("409 PAYMENT_KEY_IN_FLIGHT: the fixed retry copy, still unknown, Save stays off", async () => {
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
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(checkBtn()).toBeTruthy();
  });

  it("a Save refused 409 PAYMENT_KEY_RESOLVED: the ruling's copy, the key released, the next Save has a NEW key", async () => {
    mockPost.mockRejectedValueOnce(
      httpErr(409, { code: "PAYMENT_KEY_RESOLVED", message: "RAW SERVER TEXT" }),
    );
    await openModal();
    save();
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: RESOLVED_COPY }),
      ),
    );
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save as Paid" })).not.toBeDisabled();
    const first = keyOf(mockPost.mock.calls[0]);
    mockPost.mockRejectedValueOnce(httpErr(400));
    save();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(first);
  });

  it("error: the fixed copy (never the raw message), still unknown, Save stays off", async () => {
    await goUnknown();
    mockResolve.mockRejectedValue(httpErr(500, { message: "RAW SERVER TEXT" }));
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
    await pickCustomer();
    expect(checkBtn()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent)));
  });

  it("MUST-1: Save -> Cancel -> reopen while the request is out -> K1 times out: Save off, the check offered, the SAME key", async () => {
    let timeOut!: (e: unknown) => void;
    mockPost.mockImplementationOnce(() => new Promise((_, rej) => (timeOut = rej)));
    await openModal();
    save();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const k1 = keyOf(mockPost.mock.calls[0]);
    // Cancel is enabled while the save is pending; the modal unmounts and is reopened
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Record Payment" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
    // the reopened dialog sees the request still out once the customer is chosen: unknown, so Save is off
    // and the check is offered
    await pickCustomer();
    expect(checkBtn()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    // the first request now times out (no response)
    await act(async () => {
      timeOut(Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" }));
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(checkBtn()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(acquirePaymentKeyHolder("standalone:cust-1").peek()).toBe(k1);
    fireEvent.click(checkBtn());
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith(resolveUrl(k1)));
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("a lock landing while the dialog is open turns Save off, and a click sends nothing", async () => {
    await openModal();
    const holder = acquirePaymentKeyHolder("standalone:cust-1");
    act(() => {
      holder.keyFor({ amount: 50, method: "CASH" });
      holder.settle(holder.peek()!, { ok: false, error: httpErr(503) });
    });
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    save();
    await Promise.resolve();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
