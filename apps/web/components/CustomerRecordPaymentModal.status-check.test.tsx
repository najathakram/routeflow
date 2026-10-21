import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * SA-824 (SA conditions a/b): after an unknown outcome the dialog offers "Check payment status" (a GET by
 * key) BEFORE any new attempt. The Save buttons are DISABLED while the outcome is unknown (the calmer
 * choice: one clear next step instead of a second Save that could look like a fresh payment).
 */
const mockToast = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
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
    mockGet.mockImplementation(async () => ({ data: { data: [], meta: {} } }));
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
    mockGet.mockImplementation(async (url: string) =>
      url.includes("/payments/by-key/")
        ? { data: { paymentGroupId: "g1", payments: [{ id: "p1" }], replayed: true } }
        : { data: { data: [], meta: {} } },
    );
    check();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSuccess).toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledWith(`/invoices/payments/by-key/${encodeURIComponent(sent)}`);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This payment was recorded." }),
    );
  });

  it("not found: 'Nothing was recorded. You can try again.', Save is back, the next attempt has a NEW key", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    open();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    const first = keyOf(mockPost.mock.calls[0]);
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes("/payments/by-key/")) {
        throw httpErr(404, { code: "PAYMENT_KEY_NOT_FOUND", message: "RAW SERVER TEXT" });
      }
      return { data: { data: [], meta: {} } };
    });
    check();
    expect(await screen.findByText("Nothing was recorded. You can try again.")).toBeTruthy();
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
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes("/payments/by-key/")) throw httpErr(500, { message: "RAW SERVER TEXT" });
      return { data: { data: [], meta: {} } };
    });
    check();
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check payment status" })).toBeTruthy();
  });
});
