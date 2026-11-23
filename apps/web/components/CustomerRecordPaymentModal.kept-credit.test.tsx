import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { clearPaymentKeyRegistry } from "@routeflow/types/payment-submit-key";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * SA-1211 A1.7(e): a payment above what the open invoices need leaves an excess that stays on the account. The line reads
 * "Kept as credit" (CREDIT_WORDS.kept), never "Unallocated (→ advance)". Only the words moved: the amount is `totals.excess`.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
const open = (id: string, n: string, issued: string, balanceDue: number) => ({
  id,
  invoiceNumber: n,
  status: "SENT",
  issueDate: `${issued}T00:00:00.000Z`,
  createdAt: `${issued}T00:00:00.000Z`,
  balanceDue,
});
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(async () => ({
      data: {
        data: [open("a", "INV-A", "2026-08-01", 100), open("b", "INV-B", "2026-09-01", 250)],
        meta: {},
      },
    })),
    post: jest.fn(),
  },
}));

describe("CustomerRecordPaymentModal: the excess reads Kept as credit (A1.7e)", () => {
  beforeEach(() => clearPaymentKeyRegistry());

  it("a $25.00 excess shows Kept as credit, never Unallocated or advance", async () => {
    renderWithProviders(<CustomerRecordPaymentModal customerId="c1" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(2));
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "375" } });
    await waitFor(() => expect(screen.getByText(/Kept as credit/)).toBeInTheDocument());
    expect(screen.getByText(/Kept as credit/).parentElement).toHaveTextContent("$25.00");
    expect(document.body.textContent).not.toMatch(/Unallocated|advance/i);
  });
});
