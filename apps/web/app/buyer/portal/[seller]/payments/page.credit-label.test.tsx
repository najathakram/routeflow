import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import BuyerPaymentsPage from "./page";

/**
 * SA-1211 A1.4: the portal's credit tile reads "Credit", the one word every screen uses. The tile
 * value is unchanged (the statement's availableCredit).
 */
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: { tenant: { slug: "acme", name: "Acme" }, customer: { businessName: "Buyer" } },
  }),
}));

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerPayments: () => ({
    data: { data: [], meta: undefined },
    isLoading: false,
    isError: false,
  }),
  useBuyerStatement: () => ({ data: { availableCredit: 40, outstandingAmount: 0 } }),
  useBuyerRemittance: () => ({ data: undefined }),
  useBuyerStatementMonths: () => ({ data: { months: [] } }),
}));

jest.mock("./_components/MakePaymentPanel", () => ({ MakePaymentPanel: () => null }));

describe("BuyerPaymentsPage credit tile (A1.4)", () => {
  it('labels the tile "Credit", never "Store credit"', () => {
    renderWithProviders(<BuyerPaymentsPage />);
    expect(screen.getByText("Credit")).toBeInTheDocument();
    expect(screen.queryByText("Store credit")).toBeNull();
    expect(screen.getByText("$40.00")).toBeInTheDocument();
  });
});
