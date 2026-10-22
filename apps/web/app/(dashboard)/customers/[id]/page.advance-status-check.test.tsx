import * as React from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
  PAYMENT_STATUS_COPY,
} from "@routeflow/types/payment-submit-key";
import CustomerDetailPage from "./page";

/**
 * SA-824 (SA conditions a/b + race ruling 5): the customer page's Record Advance Payment dialog. After an
 * unknown outcome it offers "Check payment status" (POST .../by-key/:key/resolve) before any new attempt,
 * Record is off meanwhile, and a Cancel -> reopen keeps the same key. Found closes like a 2xx; a tombstone
 * releases the key; a 404, PAYMENT_KEY_IN_FLIGHT or any other error stays locked. A Save refused 409
 * PAYMENT_KEY_RESOLVED releases the key. The REAL advance mutation runs (the header, the settle).
 */
const mockToast = jest.fn();
const mockGet = jest.fn();
const mockPost = jest.fn();
const mockResolve = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "c1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  usePathname: () => "/customers/c1",
  useSearchParams: () => new URLSearchParams("tab=billing"),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => mockGet(...a),
    patch: jest.fn(),
    // the by-key resolve is its own mock so the payment POSTs keep their call indices
    post: (url: string, ...a: unknown[]) =>
      url.includes("/payments/by-key/") ? mockResolve(url, ...a) : mockPost(url, ...a),
    delete: jest.fn(),
  },
}));

const customer = {
  id: "c1",
  businessName: "Acme Foods",
  contactName: "Pat Lee",
  customerType: "BUSINESS",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "ACTIVE",
  pricingTier: 1,
  user: { status: "ACTIVE" },
  addresses: [],
};
const httpErr = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), { response: { status, data } });
const keyOf = (call: unknown[]) =>
  ((call[2] as { headers: Record<string, string> }).headers as Record<string, string>)[
    "Idempotency-Key"
  ];
const resolveUrl = (key: string) => `/invoices/payments/by-key/${encodeURIComponent(key)}/resolve`;
const RESOLVED_COPY =
  "This payment attempt was cancelled — nothing was charged. Start a new payment.";
const route = (url: string) => {
  if (url === "/customers/c1") return Promise.resolve({ data: customer });
  if (url === "/customers/c1/statement") {
    return Promise.resolve({ data: { transactions: [], creditExposure: 0 } });
  }
  if (url === "/customers/c1/routes") return Promise.resolve({ data: [] });
  if (url === "/policies") return Promise.resolve({ data: { policies: [] } });
  return Promise.resolve({ data: [] });
};

const openDialog = async () => {
  renderWithProviders(<CustomerDetailPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Record Advance Payment" }));
  await screen.findByRole("dialog");
};
const dialog = () => screen.getByRole("dialog");
const amount = () => within(dialog()).getByPlaceholderText("0.00");
const record = () => within(dialog()).getByRole("button", { name: "Record" });
const checkBtn = () => within(dialog()).getByRole("button", { name: "Check payment status" });
const goUnknown = async () => {
  mockPost.mockRejectedValueOnce(httpErr(503));
  await openDialog();
  fireEvent.change(amount(), { target: { value: "25" } });
  fireEvent.click(record());
  await within(dialog()).findByRole("button", { name: "Check payment status" });
};

describe("customers/[id] Record Advance Payment: Check payment status (SA-824)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
    mockGet.mockImplementation(route);
    mockResolve.mockResolvedValue({ data: {} });
  });

  it("an unknown outcome offers the check and disables Record", async () => {
    await goUnknown();
    expect(record()).toBeDisabled();
  });

  it("found: closes like a 2xx and the read is by the held key", async () => {
    await goUnknown();
    const sent = keyOf(mockPost.mock.calls[0]);
    mockResolve.mockResolvedValue({
      data: { state: "found", scope: "ADVANCE_PAYMENT", id: "adv-1", balance: 25 },
    });
    fireEvent.click(checkBtn());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This payment was recorded." }),
    );
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
    mockResolve.mockRejectedValue(httpErr(404, { code: "PAYMENT_KEY_NOT_FOUND" }));
    fireEvent.click(checkBtn());
    expect(
      await screen.findByText("We couldn't check right now. Try again in a moment."),
    ).toBeTruthy();
    expect(record()).toBeDisabled();
  });

  it("409 PAYMENT_KEY_IN_FLIGHT: the fixed retry copy, still unknown, Record stays off", async () => {
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

  it("a Save refused 409 PAYMENT_KEY_RESOLVED: the key is released, Record is on, the next Save has a NEW key", async () => {
    mockPost.mockRejectedValueOnce(
      httpErr(409, { code: "PAYMENT_KEY_RESOLVED", message: "RAW SERVER TEXT" }),
    );
    await openDialog();
    fireEvent.change(amount(), { target: { value: "25" } });
    fireEvent.click(record());
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(record()).not.toBeDisabled());
    expect(within(dialog()).queryByRole("button", { name: "Check payment status" })).toBeNull();
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
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Record Advance Payment" }));
    await screen.findByRole("dialog");
    expect(checkBtn()).toBeTruthy();
    expect(record()).toBeDisabled();
    fireEvent.click(checkBtn());
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith(resolveUrl(sent)));
  });

  it("a lock landing while the dialog is open turns Record off, and a click sends nothing", async () => {
    await openDialog();
    fireEvent.change(amount(), { target: { value: "25" } });
    const holder = acquirePaymentKeyHolder("advance:c1");
    act(() => {
      holder.keyFor({ amount: 25, method: "ACH" });
      holder.settle(holder.peek()!, { ok: false, error: httpErr(503) });
    });
    expect(record()).toBeDisabled();
    fireEvent.click(record());
    await Promise.resolve();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("a stay-mounted dialog reopened during a flight shows the check at once, Record visibly off with its reason", async () => {
    renderWithProviders(<CustomerDetailPage />); // mounted, dialog closed
    const opener = await screen.findByRole("button", { name: "Record Advance Payment" });
    const holder = acquirePaymentKeyHolder("advance:c1");
    let key = "";
    act(() => {
      key = holder.keyFor({ amount: 25, method: "ACH" }); // a request out from the closed dialog
    });
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    expect(checkBtn()).toBeTruthy();
    expect(record()).toBeDisabled();
    expect(within(dialog()).getByText(PAYMENT_STATUS_COPY.unknownHint)).toBeTruthy();
    act(() => holder.settle(key, { ok: true }));
    expect(within(dialog()).queryByRole("button", { name: "Check payment status" })).toBeNull();
    expect(record()).not.toBeDisabled();
  });
});
