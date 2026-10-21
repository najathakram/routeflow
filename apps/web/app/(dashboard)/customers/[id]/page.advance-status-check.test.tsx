import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
} from "@routeflow/types/payment-submit-key";
import CustomerDetailPage from "./page";

/**
 * SA-824 (SA conditions a/b): the customer page's Record Advance Payment dialog. After an unknown outcome
 * it offers "Check payment status" (a GET by key) before any new attempt, Record is off meanwhile, and a
 * Cancel -> reopen keeps the same key. Found closes like a 2xx; a 404 PAYMENT_KEY_NOT_FOUND releases the
 * key; any other error stays locked. The REAL advance mutation runs (the header, the settle).
 */
const mockToast = jest.fn();
const mockGet = jest.fn();
const mockPost = jest.fn();
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
    post: (...a: unknown[]) => mockPost(...a),
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
const route = (byKey: () => unknown) => (url: string) => {
  if (url.includes("/payments/by-key/")) return Promise.resolve(byKey());
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
    mockGet.mockImplementation(route(() => ({ data: {} })));
  });

  it("an unknown outcome offers the check and disables Record", async () => {
    await goUnknown();
    expect(record()).toBeDisabled();
  });

  it("found: closes like a 2xx and the read is by the held key", async () => {
    await goUnknown();
    const sent = keyOf(mockPost.mock.calls[0]);
    mockGet.mockImplementation(
      route(() => ({ data: { scope: "ADVANCE_PAYMENT", id: "adv-1", balance: 25 } })),
    );
    fireEvent.click(checkBtn());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockGet).toHaveBeenCalledWith(`/invoices/payments/by-key/${encodeURIComponent(sent)}`);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This payment was recorded." }),
    );
  });

  it("not found (404 PAYMENT_KEY_NOT_FOUND): released, Record is back, the next attempt has a NEW key", async () => {
    await goUnknown();
    const first = keyOf(mockPost.mock.calls[0]);
    mockGet.mockImplementation((url: string) => {
      if (url.includes("/payments/by-key/")) {
        return Promise.reject(
          httpErr(404, { code: "PAYMENT_KEY_NOT_FOUND", message: "RAW SERVER TEXT" }),
        );
      }
      return route(() => ({ data: {} }))(url);
    });
    fireEvent.click(checkBtn());
    expect(await screen.findByText("Nothing was recorded. You can try again.")).toBeTruthy();
    expect(record()).not.toBeDisabled();
    mockPost.mockRejectedValueOnce(httpErr(400));
    fireEvent.click(record());
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(2));
    expect(keyOf(mockPost.mock.calls[1])).not.toBe(first);
  });

  it("error: the fixed copy (never the raw message), still unknown, Record stays off", async () => {
    await goUnknown();
    mockGet.mockImplementation((url: string) =>
      url.includes("/payments/by-key/")
        ? Promise.reject(httpErr(500, { message: "RAW SERVER TEXT" }))
        : route(() => ({ data: {} }))(url),
    );
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
    await waitFor(() =>
      expect(mockGet).toHaveBeenCalledWith(`/invoices/payments/by-key/${encodeURIComponent(sent)}`),
    );
  });

  it("the click handler re-checks the unknown lock when it lands after the last render", async () => {
    await openDialog();
    fireEvent.change(amount(), { target: { value: "25" } });
    const holder = acquirePaymentKeyHolder("advance:c1");
    holder.keyFor({ amount: 25, method: "ACH" });
    holder.settle({ ok: false, error: httpErr(503) });
    expect(record()).not.toBeDisabled();
    fireEvent.click(record());
    await Promise.resolve();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
