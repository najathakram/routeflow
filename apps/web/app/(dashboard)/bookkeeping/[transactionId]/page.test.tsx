import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import TransactionDetailPage from "./page";

/**
 * UX guide B13: a ledger "transaction" is an Invoice row, so its old detail page (order number under the word
 * "INVOICE", the RouteFlow logo instead of the tenant's) is replaced by the invoice page itself.
 */
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ transactionId: "inv-1" }),
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

describe("/bookkeeping/[transactionId] (UX guide B13)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("redirects an old link to the invoice page and renders no page of its own", () => {
    renderWithProviders(<TransactionDetailPage />);
    expect(mockReplace).toHaveBeenCalledWith("/invoices/inv-1");
    expect(screen.queryByText(/routeflow/i)).toBeNull();
  });
});
