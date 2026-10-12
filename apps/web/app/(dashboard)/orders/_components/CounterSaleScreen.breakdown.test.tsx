import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-01 / CQ-02 / CQ-08 through the real screen: the checkout panel explains its number (Subtotal, Tax, one named charge
 * per regulated category, Estimated total), the total carries the deposit / excise the receipt prints, and an exempt
 * customer's panel carries neither tax nor levy.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 10, unit: "each", unitsPerBox: null };
const SODA = {
  id: "p-soda",
  name: "Soda",
  pricePerUnit: 10,
  unit: "each",
  unitsPerBox: null,
  trackedCategoryId: "cat-crv",
};
const CIGAR = {
  id: "p-cigar",
  name: "Cigar",
  pricePerUnit: 10,
  unit: "each",
  unitsPerBox: null,
  trackedCategoryId: "cat-tob",
};
const PRODUCTS: Record<string, unknown> = { COLA, SODA, CIGAR };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    PRODUCTS[code] ? { product: PRODUCTS[code], source: "sku" } : { notFound: true },
}));
const TAXED = { id: "c-taxed", businessName: "Taxed Cafe", pricingTier: 1, isTaxExempt: false };
const EXEMPT = { id: "c-exempt", businessName: "Exempt Cafe", pricingTier: 1, isTaxExempt: true };
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [TAXED, EXEMPT] } }),
  useCustomerPrices: () => ({ data: [] }),
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const CATEGORIES = [
  {
    id: "cat-crv",
    name: "CRV",
    taxType: "DEPOSIT_PER_CONTAINER",
    rate: "0.1000",
    priceIncludesTax: false,
    active: true,
  },
  {
    id: "cat-tob",
    name: "Tobacco",
    taxType: "EXCISE_PER_UNIT",
    rate: "0.5000",
    priceIncludesTax: false,
    active: true,
  },
];

const get = apiClient.get as unknown as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockImplementation((url: string) => {
    if (url === "/settings") return Promise.resolve({ data: { taxRate: 8.25 } });
    if (url === "/tracked-categories") return Promise.resolve({ data: CATEGORIES });
    return Promise.resolve({ data: [] });
  });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const pick = (name: string) => {
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "cafe" } });
  fireEvent.click(screen.getByRole("button", { name }));
};
const text = (id: string) => screen.getByTestId(id).textContent ?? "";

describe("counter checkout panel: the number explains itself (CQ-08) and matches the receipt (CQ-01)", () => {
  it("a taxed cart with a deposit and an excise item: Subtotal, Tax, one named charge each, Estimated total", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await scan("SODA");
    await scan("CIGAR");
    await waitFor(() => expect(text("running-subtotal")).toContain("$30.00"));
    await waitFor(() => expect(text("running-tax")).toContain("$2.48")); // 8.25% of 30.00
    await waitFor(() => expect(text("running-charge-cat-crv")).toContain("$0.10"));
    expect(text("running-charge-cat-crv")).toContain("CRV deposit");
    expect(text("running-charge-cat-tob")).toContain("$0.50");
    expect(text("running-charge-cat-tob")).toContain("Tobacco excise");
    // 30.00 + 2.48 + 0.10 + 0.50
    expect(text("running-total")).toContain("$33.08");
  });

  it("an exempt customer's panel carries no tax row and no charge: total = subtotal", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("SODA");
    await scan("CIGAR");
    pick("Exempt Cafe");
    await waitFor(() => expect(text("running-total")).toContain("$20.00"));
    expect(screen.queryByTestId("running-tax")).toBeNull();
    expect(screen.queryByTestId("running-charge-cat-crv")).toBeNull();
    expect(text("running-subtotal")).toContain("$20.00");
  });

  it("a cart with no tax and no regulated line shows just Subtotal and Total", async () => {
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === "/settings" ? { taxRate: 0 } : [] }),
    );
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(text("running-total")).toContain("$10.00"));
    expect(text("running-subtotal")).toContain("$10.00");
    expect(screen.queryByTestId("running-tax")).toBeNull();
  });
});

describe("a regulated line waits for the categories before it can be paid (fail-safe)", () => {
  it("while the categories load, Complete says why and sends nothing", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/settings") return Promise.resolve({ data: { taxRate: 8.25 } });
      if (url === "/tracked-categories") return new Promise(() => undefined); // never answers
      return Promise.resolve({ data: [] });
    });
    renderWithProviders(<CounterSaleScreen />);
    await scan("SODA");
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Still loading the regulated charges. Try again in a moment.",
      ),
    );
  });
});
