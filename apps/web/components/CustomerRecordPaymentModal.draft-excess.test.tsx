import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { clearPaymentKeyRegistry } from "@routeflow/types/payment-submit-key";
import { CustomerRecordPaymentModal } from "./CustomerRecordPaymentModal";

/**
 * B1385: a draft payment cannot carry a leftover (it would become spendable credit), so "Save as draft" is disabled
 * while an excess exists, with the same hint as the finance/payments page. "Save as paid" stays enabled.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: { id: "u1", role: "OPERATOR" } }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(async () => ({
      data: {
        data: [
          {
            id: "a",
            invoiceNumber: "INV-A",
            status: "SENT",
            issueDate: "2026-08-01T00:00:00.000Z",
            createdAt: "2026-08-01T00:00:00.000Z",
            balanceDue: 100,
          },
        ],
        meta: {},
      },
    })),
    post: jest.fn(),
  },
}));

describe("CustomerRecordPaymentModal: no draft with a leftover (B1385)", () => {
  beforeEach(() => clearPaymentKeyRegistry());

  it("a $25 excess disables Save as draft (with the hint) and keeps Save as paid enabled", async () => {
    renderWithProviders(<CustomerRecordPaymentModal customerId="c1" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "125" } });
    await waitFor(() => expect(screen.getByText(/Kept as credit/)).toBeInTheDocument());
    const draft = screen.getByRole("button", { name: "Save as draft" });
    expect(draft).toBeDisabled();
    expect(draft).toHaveAttribute("title", "Allocate the full amount to save as a draft");
    expect(screen.getByRole("button", { name: "Save as paid" })).toBeEnabled();
  });

  it("control: with the full amount allocated and no excess, Save as draft is enabled", async () => {
    renderWithProviders(<CustomerRecordPaymentModal customerId="c1" onClose={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    fireEvent.change(screen.getAllByPlaceholderText("0.00")[0], { target: { value: "100" } });
    await waitFor(() => expect(screen.queryByText(/Kept as credit/)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save as draft" })).toBeEnabled();
  });
});
