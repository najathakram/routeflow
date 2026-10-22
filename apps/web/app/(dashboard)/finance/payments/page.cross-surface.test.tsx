import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import {
  acquirePaymentKeyHolder,
  clearPaymentKeyRegistry,
  PAYMENT_STATUS_COPY,
} from "@routeflow/types/payment-submit-key";
import { CustomerRecordPaymentModal } from "@/components/CustomerRecordPaymentModal";
import FinancePaymentsPage from "./page";

/**
 * SA-824 (lead ruling, MUST 2): the holder scope is WRITER + TARGET, never the surface name. The Payments page
 * dialog and the customer's Record Payment dialog hit the same writer (POST /invoices/payments/record) for the
 * same customer, so an unknown outcome on one blocks a new key on the other, in both directions. The Payments
 * page resolves its scope when the customer is chosen, and cannot change the customer mid-attempt.
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
    post: (url: string, ...a: unknown[]) =>
      url.includes("/payments/by-key/") ? mockResolve(url, ...a) : mockPost(url, ...a),
  },
}));

const httpErr = (status: number) =>
  Object.assign(new Error("RAW SERVER TEXT"), { response: { status, data: {} } });
const list = { data: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 1 } } };
const routes = async (url: string) => {
  if (url.startsWith("/customers")) {
    return {
      data: {
        data: [
          { id: "cust-1", businessName: "Acme Foods" },
          { id: "cust-2", businessName: "Beta Foods" },
        ],
        meta: {},
      },
    };
  }
  return list;
};
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save as Paid" }));
const checkBtn = () => screen.queryByRole("button", { name: "Check payment status" });
const amountField = () => screen.getAllByPlaceholderText("0.00")[0];

async function openPaymentsPage(customer = "cust-1") {
  const view = renderWithProviders(<FinancePaymentsPage />);
  fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
  await screen.findAllByRole("option", { name: /Acme Foods/ });
  fireEvent.change(screen.getByDisplayValue("Select customer..."), { target: { value: customer } });
  fireEvent.change(amountField(), { target: { value: "50" } });
  return view;
}

describe("one payment target, one holder, whichever dialog is open (SA-824)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPaymentKeyRegistry();
    mockGet.mockImplementation(routes);
    mockResolve.mockResolvedValue({ data: {} });
  });

  it("unknown on the Payments page blocks a new key in the customer's dialog for the same customer", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    const page = await openPaymentsPage();
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    expect(mockPost).toHaveBeenCalledTimes(1);
    page.unmount();
    renderWithProviders(<CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />);
    fireEvent.change(amountField(), { target: { value: "50" } });
    expect(checkBtn()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    save();
    await Promise.resolve();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("unknown in the customer's dialog blocks a new key on the Payments page for the same customer", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    const modal = renderWithProviders(
      <CustomerRecordPaymentModal customerId="cust-1" onClose={jest.fn()} />,
    );
    fireEvent.change(amountField(), { target: { value: "50" } });
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    modal.unmount();
    await openPaymentsPage("cust-1");
    expect(checkBtn()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save as Paid" })).toBeDisabled();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it("a different customer is an independent target", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    const page = await openPaymentsPage("cust-1");
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    page.unmount();
    renderWithProviders(<CustomerRecordPaymentModal customerId="cust-2" onClose={jest.fn()} />);
    expect(checkBtn()).toBeNull();
  });

  it("no holder is minted before a customer is chosen: Save without one sends nothing", async () => {
    renderWithProviders(<FinancePaymentsPage />);
    fireEvent.click(screen.getAllByRole("button", { name: /Record Payment/ })[0]);
    await screen.findAllByRole("option", { name: /Acme Foods/ });
    fireEvent.change(amountField(), { target: { value: "50" } });
    save();
    await Promise.resolve();
    expect(mockPost).not.toHaveBeenCalled();
    expect(acquirePaymentKeyHolder("standalone:cust-1").peek()).toBeNull();
    expect(acquirePaymentKeyHolder("standalone:payments-page").peek()).toBeNull();
  });

  it("changing the customer while the outcome is unknown is blocked, with a fixed reason", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    await openPaymentsPage("cust-1");
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    const picker = screen.getByDisplayValue("Acme Foods") as HTMLSelectElement;
    expect(picker).toBeDisabled();
    expect(screen.getByText(PAYMENT_STATUS_COPY.customerLocked)).toBeTruthy();
    fireEvent.change(picker, { target: { value: "cust-2" } });
    expect(picker.value).toBe("cust-1");
    expect(checkBtn()).toBeTruthy();
  });

  it("changing the customer while a request is in flight is blocked", async () => {
    let finish!: (v: unknown) => void;
    mockPost.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    await openPaymentsPage("cust-1");
    save();
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(screen.getByDisplayValue("Acme Foods")).toBeDisabled();
    await act(async () => {
      finish({ data: { payments: [{ id: "p1" }] } });
    });
  });

  it("after the check resolves (released), the customer can be changed again", async () => {
    mockPost.mockRejectedValueOnce(httpErr(503));
    await openPaymentsPage("cust-1");
    save();
    await screen.findByRole("button", { name: "Check payment status" });
    mockResolve.mockResolvedValue({ data: { state: "tombstoned" } });
    fireEvent.click(checkBtn()!);
    await waitFor(() => expect(screen.getByDisplayValue("Acme Foods")).not.toBeDisabled());
  });
});
