import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * SA-1050 PR-A: "Write off" leaves the Record payment dropdown for the invoice's More menu, behind the same gate
 * (an open invoice, not read-only). The confirm states the amount being written off, and quick reasons fill the
 * required text. The "cannot be undone" copy stays until the reinstate PR.
 */
const mockWriteOff = jest.fn();
let mockStatus = "SENT";
let mockReadOnly = false;
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ id: "inv-1" }),
  usePathname: () => "/invoices/inv-1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/lib/read-only-gate", () => ({
  ...jest.requireActual("@/lib/read-only-gate"),
  useReadOnlyGate: () => ({ readOnly: mockReadOnly, line: null, hintId: "ro-line" }),
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
    useWriteOffInvoice: () => ({ mutate: mockWriteOff, isPending: false }),
    useInvoice: () => ({
      data: {
        id: "inv-1",
        invoiceNumber: "INV-0014",
        status: mockStatus,
        total: "107.00",
        paidAmount: "0.00",
        balanceDue: mockStatus === "PAID" ? "0.00" : "107.00",
        issueDate: "2026-09-01T00:00:00.000Z",
        customerId: "c1",
        customer: { id: "c1", businessName: "Acme Foods" },
        items: [],
        payments: [],
        orderId: "o1",
      },
      isLoading: false,
      isError: false,
    }),
  };
});
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
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

const openMore = () => fireEvent.click(screen.getByTitle("More actions"));
const openRecordPayment = () => fireEvent.click(screen.getByTestId("record-payment-trigger"));

describe("invoices/[id]: Write off lives in the More menu (SA-1050 PR-A)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStatus = "SENT";
    mockReadOnly = false;
    seedSession("OPERATOR");
  });
  afterEach(() => seedSession(null));

  it("is gone from the Record payment dropdown", () => {
    renderWithProviders(<InvoiceDetailPage />);
    openRecordPayment();
    expect(screen.getByRole("button", { name: "Apply advance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write off" })).not.toBeInTheDocument();
  });

  it("is the danger item of the More menu on an open invoice", () => {
    renderWithProviders(<InvoiceDetailPage />);
    openMore();
    const item = screen.getByRole("button", { name: "Write off" });
    expect(item).toBeEnabled();
    expect(item.className).toMatch(/text-danger/);
  });

  it("is not offered once the invoice is no longer open", () => {
    mockStatus = "PAID";
    renderWithProviders(<InvoiceDetailPage />);
    openMore();
    expect(screen.queryByRole("button", { name: "Write off" })).not.toBeInTheDocument();
  });

  it("stays in the menu but disabled while the workspace is read-only", () => {
    mockReadOnly = true;
    renderWithProviders(<InvoiceDetailPage />);
    openMore();
    expect(screen.getByRole("button", { name: "Write off" })).toBeDisabled();
  });

  it("the confirm states the amount and keeps the cannot-be-undone copy", () => {
    renderWithProviders(<InvoiceDetailPage />);
    openMore();
    fireEvent.click(screen.getByRole("button", { name: "Write off" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("write-off-amount")).toHaveTextContent("$107.00");
    expect(dialog).toHaveTextContent("This action cannot be undone.");
  });

  it("quick reasons fill the required text and the write-off sends it", () => {
    renderWithProviders(<InvoiceDetailPage />);
    openMore();
    fireEvent.click(screen.getByRole("button", { name: "Write off" }));
    const dialog = screen.getByRole("dialog");
    for (const label of ["Customer closed", "Bankrupt", "Disputed", "Can't reach them", "Other"]) {
      expect(within(dialog).getByRole("button", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Bankrupt" }));
    expect(within(dialog).getByRole("textbox", { name: /reason/i })).toHaveValue("Bankrupt");
    fireEvent.click(within(dialog).getByRole("button", { name: "Write off" }));
    expect(mockWriteOff).toHaveBeenCalledTimes(1);
    expect(mockWriteOff.mock.calls[0][0]).toEqual({ id: "inv-1", reason: "Bankrupt" });
  });

  it("Other empties the text and asks for the person's own words", () => {
    renderWithProviders(<InvoiceDetailPage />);
    openMore();
    fireEvent.click(screen.getByRole("button", { name: "Write off" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disputed" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Other" }));
    const box = within(dialog).getByRole("textbox", { name: /reason/i });
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Write off" }));
    expect(mockWriteOff).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/provide a reason/i)).toBeInTheDocument();
  });

  it("an empty reason is still refused", () => {
    renderWithProviders(<InvoiceDetailPage />);
    openMore();
    fireEvent.click(screen.getByRole("button", { name: "Write off" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Write off" }));
    expect(mockWriteOff).not.toHaveBeenCalled();
  });
});
