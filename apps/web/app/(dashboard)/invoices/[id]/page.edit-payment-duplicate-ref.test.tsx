import * as React from "react";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { API_ERROR_CODES } from "@routeflow/types";
import InvoiceDetailPage from "./page";

/**
 * W-718 (row 752 follow-up): the payment EDIT dialog answers a 409 DUPLICATE_PAYMENT_REF like every record-payment
 * surface: ONE toast naming the existing payment (the app-wide toast stays quiet) and, for staff, "Record anyway",
 * which resends the SAME edit with `recordAnyway: true`. A non-staff role gets the sentence without the action.
 */
const mockToast = jest.fn();
const mockGlobalToast = jest.fn();
const mockPatch = jest.fn();
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
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn(),
    patch: (...a: unknown[]) => mockPatch(...a),
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
    useUpdateInvoicePayment: actual.useUpdateInvoicePayment, // the REAL hook: its meta and body are under test
    useInvoice: () => ({
      data: {
        id: "inv-1",
        invoiceNumber: "INV-0014",
        status: "PARTIALLY_PAID",
        total: "35.00",
        paidAmount: "10.00",
        balanceDue: "25.00",
        issueDate: "2026-09-01T00:00:00.000Z",
        customer: { id: "c1", businessName: "Acme Foods" },
        items: [],
        payments: [
          {
            id: "pay-1",
            method: "CHECK",
            amount: "10.00",
            status: "PAID",
            reference: "1042",
            paidAt: "2026-10-01T00:00:00.000Z",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
        ],
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

const duplicate = () =>
  refusal(409, {
    code: API_ERROR_CODES.DUPLICATE_PAYMENT_REF,
    message: "RAW",
    existingPayment: {
      id: "pay-0",
      paidAt: "2026-09-28T00:00:00.000Z",
      amount: 10,
      invoiceId: "inv-0",
      invoiceNumber: "INV-0009",
    },
  });

function saveEdit() {
  renderWithProviders(<InvoiceDetailPage />, {
    queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
  });
  fireEvent.click(screen.getByTitle("Edit payment"));
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
}

const dupToast = () =>
  mockToast.mock.calls.map((c) => c[0]).find((t) => t.title === "Possible duplicate payment");

describe("invoices/[id]: editing a payment onto a used reference (W-718)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => seedSession(null));

  it("staff: one toast naming the existing payment; Record anyway resends the same edit with recordAnyway", async () => {
    seedSession("OPERATOR");
    mockPatch.mockRejectedValueOnce(duplicate()).mockResolvedValueOnce({ data: { id: "inv-1" } });
    saveEdit();
    await waitFor(() => expect(dupToast()).toBeDefined());
    const t = dupToast();
    expect(t.description).toContain("INV-0009");
    expect(mockToast.mock.calls.some((c) => c[0].title === "Failed to update payment")).toBe(false);
    expect(mockGlobalToast).not.toHaveBeenCalled();
    expect(t.action?.label).toBe("Record anyway");

    const [url, first] = mockPatch.mock.calls[0];
    expect(url).toBe("/invoices/inv-1/payments/pay-1");
    expect(first.recordAnyway).toBeUndefined();
    await act(async () => t.action.onClick());
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2));
    const second = mockPatch.mock.calls[1][1];
    expect(second).toEqual({ ...first, recordAnyway: true });
  });

  it("a non-staff role: the sentence, no Record anyway", async () => {
    seedSession("DRIVER");
    mockPatch.mockRejectedValueOnce(duplicate());
    saveEdit();
    await waitFor(() => expect(dupToast()).toBeDefined());
    expect(dupToast().action).toBeUndefined();
  });
});

// W-663 (SA-843 filing): emptying the reference (or the notes) in the edit dialog CLEARS it: the PATCH sends null, the way
// an emptied bank date already does. Head: undefined, so the server kept the old reference.
describe("invoices/[id]: an emptied reference is cleared (W-663)", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => seedSession(null));

  it("the PATCH sends reference: null and notes: null for emptied fields", async () => {
    seedSession("OPERATOR");
    mockPatch.mockResolvedValueOnce({ data: { id: "inv-1" } });
    renderWithProviders(<InvoiceDetailPage />, {
      queryClient: queryClientWithGlobalErrorToast(mockGlobalToast),
    });
    fireEvent.click(screen.getByTitle("Edit payment"));
    fireEvent.change(screen.getByDisplayValue("1042"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    const body = mockPatch.mock.calls[0][1];
    expect(body.reference).toBeNull();
    expect(body.notes).toBeNull();
  });
});
