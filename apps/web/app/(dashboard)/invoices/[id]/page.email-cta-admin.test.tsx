import * as React from "react";
import userEvent from "@testing-library/user-event";
import { screen, renderWithProviders } from "@/test-utils/render";
import InvoiceDetailPage from "./page";

/**
 * SA #3412 nit: Email settings are admin-only, so a send refused with EMAIL_NOT_CONFIGURED no longer sends
 * an operator to a screen that only says "Only an admin can change this." It tells them who can fix it and
 * stays put. An account admin is still taken to Email settings.
 */

let mockInvoice: Record<string, unknown>;
let mockRole = "OPERATOR";
const mockPush = jest.fn();

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: { id: "u1", role: mockRole, firstName: "Ada", lastName: "Op", email: "a@example.com" },
    logout: jest.fn(),
  }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useParams: () => ({ id: "inv-1" }),
  usePathname: () => "/invoices/inv-1",
  useSearchParams: () => new URLSearchParams(),
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
    useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
    useSendInvoiceEmail: () => ({
      isPending: false,
      mutate: (_v: unknown, opts: { onError?: (e: unknown) => void }) =>
        opts.onError?.({ response: { status: 409, data: { code: "EMAIL_NOT_CONFIGURED" } } }),
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

const draft = {
  id: "inv-1",
  invoiceNumber: "INV-0014",
  status: "DRAFT",
  total: "35.00",
  paidAmount: "0",
  balanceDue: "35.00",
  issueDate: "2026-09-01T00:00:00.000Z",
  dueDate: "2026-09-15T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods", email: "ap@acme.test" },
  items: [],
  payments: [],
};

describe("InvoiceDetailPage: Send with email not set up (SA #3412 nit)", () => {
  beforeEach(() => {
    mockInvoice = draft;
    mockPush.mockClear();
  });

  it("an operator is told to ask an account admin and is not sent to Email settings", async () => {
    mockRole = "OPERATOR";
    renderWithProviders(<InvoiceDetailPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText("Ask an account admin to set up email.")).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalledWith("/settings?tab=email");
  });

  it("an account admin is still taken to Email settings", async () => {
    mockRole = "TENANT_ADMIN";
    renderWithProviders(<InvoiceDetailPage />);
    await userEvent.setup().click(screen.getByRole("button", { name: /^send$/i }));
    expect(mockPush).toHaveBeenCalledWith("/settings?tab=email");
  });
});
