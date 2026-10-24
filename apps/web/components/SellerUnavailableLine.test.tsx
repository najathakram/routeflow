import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { SellerUnavailableLine, sellerUnavailableCopy } from "./SellerUnavailableLine";

let mockCapability: { data?: { acceptingOrders?: boolean } } = {};
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => mockCapability,
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({ activeSeller: { tenant: { name: "Acme Foods" } } }),
}));

/**
 * SA-733r6 (B4), buyer side: a paused seller shows ONE quiet line (the exact signed copy); a healthy, loading or
 * unknown seller shows nothing; no billing wording ever reaches a buyer.
 */
describe("SellerUnavailableLine", () => {
  it("paused seller: the exact line, naming the seller", () => {
    mockCapability = { data: { acceptingOrders: false } };
    renderWithProviders(<SellerUnavailableLine />);
    expect(screen.getByTestId("seller-unavailable-line")).toHaveTextContent(
      "Acme Foods isn't taking online orders right now. Please check back soon or contact them.",
    );
  });

  it("accepting, loading or unknown: nothing (grace is never shown to a buyer)", () => {
    for (const cap of [{ data: { acceptingOrders: true } }, {}, { data: {} }]) {
      mockCapability = cap;
      const { unmount } = renderWithProviders(<SellerUnavailableLine />);
      expect(screen.queryByTestId("seller-unavailable-line")).toBeNull();
      unmount();
    }
  });

  it("the copy has no payment / billing / subscribe / plan wording", () => {
    expect(sellerUnavailableCopy("Acme Foods")).not.toMatch(
      /payment|billing|subscri|plan|overdue/i,
    );
    expect(sellerUnavailableCopy(null)).toBe(
      "This seller isn't taking online orders right now. Please check back soon or contact them.",
    );
  });
});
