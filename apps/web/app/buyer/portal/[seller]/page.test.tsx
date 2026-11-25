import * as React from "react";
import { renderWithProviders, screen, waitFor } from "@/test-utils/render";
import BuyerSellerRoot from "./page";

/**
 * SA-1211 A1.2: a buyer with 0 counted orders lands on Invoices, an ordering buyer keeps the page
 * they had, a loader shows while the read is in flight (never a flash of Orders), and a failed read
 * sends the buyer where they went before.
 */
const replace = jest.fn();
let search = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ replace, push: jest.fn() }),
  useSearchParams: () => search,
}));

const mockGet = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

let auth: { isLoading: boolean; activeSeller: unknown };
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => auth,
}));

const analytics = (totalOrders: number) => ({
  data: { summary: { totalOrders }, monthlySpend: [] },
});

beforeEach(() => {
  replace.mockClear();
  mockGet.mockReset();
  search = new URLSearchParams();
  auth = { isLoading: false, activeSeller: { tenant: { slug: "acme", name: "Acme" } } };
});

describe("BuyerSellerRoot landing (A1.2)", () => {
  it("sends a buyer with 0 counted orders to Invoices", async () => {
    mockGet.mockResolvedValue(analytics(0));
    renderWithProviders(<BuyerSellerRoot />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/buyer/portal/acme/invoices"));
  });

  it("sends an ordering buyer to Orders when they came from the seller list", async () => {
    search = new URLSearchParams("then=orders");
    mockGet.mockResolvedValue(analytics(3));
    renderWithProviders(<BuyerSellerRoot />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/buyer/portal/acme/orders"));
  });

  it("keeps an ordering buyer's dashboard on a direct visit", async () => {
    mockGet.mockResolvedValue(analytics(3));
    renderWithProviders(<BuyerSellerRoot />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/buyer/portal/acme/dashboard"));
  });

  it("shows a loader and navigates nowhere while the read is in flight", async () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<BuyerSellerRoot />);
    expect(await screen.findByRole("status")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("falls back to Orders when the read fails", async () => {
    search = new URLSearchParams("then=orders");
    mockGet.mockRejectedValue(new Error("boom"));
    renderWithProviders(<BuyerSellerRoot />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/buyer/portal/acme/orders"));
  });
});
