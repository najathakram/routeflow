import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
  PAYMENT_PHOTO_LATER_COPY,
} from "@routeflow/types/payment-submit-key";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * SA-824 (SA conditions a/b + race ruling 5): after an unknown outcome the dialog offers "Check payment
 * status" (POST .../by-key/:key/resolve) BEFORE any new attempt. Only found / tombstoned release the key.
 * The Save buttons are DISABLED while the outcome is unknown (the calmer choice: one clear next step instead
 * of a second Save that could look like a fresh payment).
 */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
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
const resolveUrl = (key: string) => `/invoices/payments/by-key/${encodeURIComponent(key)}/resolve`;
const RESOLVED_COPY =
  "This payment attempt was cancelled — nothing was charged. Start a new payment.";

const httpErr = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), { response: { status, data } });
const keyOf = (call: unknown[]) =>
  ((call[2] as { headers: Record<string, string> }).headers as Record<string, string>)[
    "Idempotency-Key"
  ];

function open() {
  const onClose = jest.fn();
  const onSuccess = jest.fn();
  renderWithProviders(
    <CustomerRecordPaymentModal customerId="cust-1" onClose={onClose} onSuccess={onSuccess} />,
  );
  fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
  return { onClose, onSuccess };
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));
const check = () => fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));

describe("CustomerRecordPaymentModal: Check payment status (SA-824)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
    mockGet.mockImplementation(async () => ({ data: { data: [], meta: {} } }));
    mockResolve.mockResolvedValue({ data: {} });
  });

  it("no unknown outcome: no check action", () => {
    open();
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
  });

  it("an unknown outcome offers the check and disables Save", async () => {
    mockPost.mockRejectedValue(httpErr(503));
    open();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeDisabled();
  });

  it("found: 'This payment was recorded.', closes and refreshes like a 2xx; the read is by the held key", async () => {
    mockPost.mockRejectedValue(httpErr(503));
    const { onClose, onSuccess } = open();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    const sent = keyOf(mockPost.mock.calls[0]);
    mockResolve.mockResolvedValue({
      data: { state: "found", paymentGroupId: "g1", payments: [{ id: "p1" }], replayed: true },
    });
    check();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSuccess).toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This payment was recorded." }),
    );
  });

  it("tombstoned: the ruling's copy, Save is back, the next attempt has a NEW key", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    open();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    const first = keyOf(mockPost.mock.calls[0]);
    mockResolve.mockResolvedValue({ data: { state: "tombstoned" } });
    check();
    expect(await screen.findByText(RESOLVED_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).not.toBeDisabled();
    mockPost.mockRejectedValueOnce(httpErr(400));
    save();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(first);
  });

  it("error: the fixed 'couldn't check' copy (never the raw message), still unknown, Save stays off", async () => {
    mockPost.mockRejectedValue(httpErr(503));
    open();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    mockResolve.mockRejectedValue(httpErr(500, { message: "RAW SERVER TEXT" }));
    check();
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
  });

  it("close -> reopen with an unknown outcome: the SAME key, Save still off, the check still offered", async () => {
    mockPost.mockRejectedValue(httpErr(503));
    const first = renderWithProviders(
      <CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />,
    );
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    const sent = keyOf(mockPost.mock.calls[0]);
    first.unmount(); // Cancel
    renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeDisabled();
    mockResolve.mockResolvedValue({
      data: { state: "found", paymentGroupId: "g1", payments: [{ id: "p1" }] },
    });
    check();
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent)));
  });

  it("a different customer's dialog is not blocked by this customer's unknown outcome", async () => {
    mockPost.mockRejectedValue(httpErr(503));
    const first = renderWithProviders(
      <CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />,
    );
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    first.unmount();
    renderWithProviders(<CustomerRecordPaymentModal customerId="cust-2" onClose={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
  });

  it("a 404 (even PAYMENT_KEY_NOT_FOUND) never releases (race ruling 5): still unknown, Save stays off", async () => {
    mockPost.mockRejectedValue(httpErr(503));
    open();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    mockResolve.mockRejectedValue(httpErr(404, { code: "PAYMENT_KEY_NOT_FOUND" }));
    check();
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
  });

  it("409 PAYMENT_KEY_IN_FLIGHT: the fixed retry copy, still unknown, Save stays off", async () => {
    mockPost.mockRejectedValue(httpErr(503));
    open();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    mockResolve.mockRejectedValue(
      httpErr(409, { code: "PAYMENT_KEY_IN_FLIGHT", message: "RAW SERVER TEXT" }),
    );
    check();
    expect(
      await screen.findByText(
        "This payment is still being recorded. Check its status again in a moment.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
  });

  it("a Save refused 409 PAYMENT_KEY_RESOLVED: the ruling's copy, the key released, the next Save has a NEW key", async () => {
    mockPost.mockRejectedValueOnce(
      httpErr(409, { code: "PAYMENT_KEY_RESOLVED", message: "RAW SERVER TEXT" }),
    );
    open();
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

  it("after a release (tombstoned) a reopen gets a fresh key and Save is on", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    const first = renderWithProviders(
      <CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />,
    );
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    const firstKey = keyOf(mockPost.mock.calls[0]);
    mockResolve.mockResolvedValue({ data: { state: "tombstoned" } });
    check();
    await screen.findByText(RESOLVED_COPY);
    first.unmount();
    mockPost.mockRejectedValueOnce(httpErr(400));
    renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />);
    expect(screen.queryByRole("button", { name: "Check payment status" })).toBeNull();
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
    save();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(firstKey);
  });

  it("the submit handler re-checks the unknown lock (not only the disabled prop)", async () => {
    open();
    // The lock lands between render and click (no re-render yet): the button is still enabled.
    const holder = acquirePaymentKeyHolder("standalone:cust-1");
    holder.keyFor({ amount: 50, method: "CASH" });
    holder.settle({ ok: false, error: httpErr(503) });
    expect(screen.getByRole("button", { name: "Save as Paid" })).not.toBeDisabled();
    save();
    await Promise.resolve();
    expect(mockPost).not.toHaveBeenCalled();
  });

  describe("found: the selected proof photo", () => {
    const pickPhoto = () => {
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      fireEvent.change(input, {
        target: { files: [new File(["x"], "check.png", { type: "image/png" })] },
      });
    };
    const imageCalls = () =>
      mockPost.mock.calls.filter((c) => String(c[0]).includes("/image")).map((c) => c[0]);

    it("uploads it against the found payment's id, same call as the 2xx path", async () => {
      mockPost.mockRejectedValueOnce(httpErr(503));
      const { onClose } = open();
      pickPhoto();
      save();
      await screen.findByRole("button", { name: "Check payment status" });
      mockResolve.mockResolvedValue({
        data: {
          state: "found",
          scope: "STANDALONE_PAYMENT",
          paymentGroupId: "g1",
          payments: [{ id: "p1" }, { id: "p2" }],
        },
      });
      mockPost.mockResolvedValue({ data: { url: "u" } });
      check();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(imageCalls()).toEqual(["/invoices/payments/p1/image"]);
    });

    it("still uploads it after a close -> reopen (the photo is remembered with the key)", async () => {
      mockPost.mockRejectedValueOnce(httpErr(503));
      const { unmount } = renderWithProviders(
        <CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />,
      );
      fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "50" } });
      pickPhoto();
      save();
      await screen.findByRole("button", { name: "Check payment status" });
      unmount();
      const onClose = jest.fn();
      renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={onClose} />);
      mockResolve.mockResolvedValue({
        data: { state: "found", paymentGroupId: "g1", payments: [{ id: "p1" }] },
      });
      mockPost.mockResolvedValue({ data: { url: "u" } });
      check();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(imageCalls()).toEqual(["/invoices/payments/p1/image"]);
    });

    it("a found payment with no derivable id: fixed 'add the photo from the payment' copy, no upload, still closes", async () => {
      mockPost.mockRejectedValueOnce(httpErr(503));
      const { onClose } = open();
      pickPhoto();
      save();
      await screen.findByRole("button", { name: "Check payment status" });
      mockResolve.mockResolvedValue({
        data: { state: "found", scope: "STANDALONE_PAYMENT", paymentGroupId: "g1", payments: [] },
      });
      check();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(imageCalls()).toEqual([]);
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: PAYMENT_PHOTO_LATER_COPY }),
      );
    });

    it("an upload failure on the found path is the existing fixed failure toast, and the dialog still closes", async () => {
      mockPost.mockRejectedValueOnce(httpErr(503));
      const { onClose } = open();
      pickPhoto();
      save();
      await screen.findByRole("button", { name: "Check payment status" });
      mockResolve.mockResolvedValue({
        data: { state: "found", paymentGroupId: "g1", payments: [{ id: "p1" }] },
      });
      mockPost.mockRejectedValue(httpErr(500, { message: "RAW SERVER TEXT" }));
      check();
      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Payment saved, image upload failed" }),
      );
    });
  });
});
