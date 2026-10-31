import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { renderTill } from "@/test-utils/render-till";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * SA-1066 M8 + F7: the counter's running figure reads "Total" (the owner's 10-24 word), and the sale's bottom figure is
 * one size whatever the method: Amount due / Change on cash, Total on anything else. A cash tender in progress keeps
 * Total at a smaller size above Amount due. Picking a customer can change the method, so the same figure never shrinks.
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
    requiresLicense: true,
    active: true,
  },
];

const get = apiClient.get as unknown as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockImplementation((url: string) => {
    // a named customer on Net 30 terms: picking one flips the default tender from Cash to On account (SA-933)
    const one = /^\/customers\/([^/]+)$/.exec(url);
    if (one) return Promise.resolve({ data: { id: one[1], defaultPaymentTerms: "Net 30" } });
    if (/^\/customers\/[^/]+\/statement$/.test(url))
      return Promise.resolve({
        data: { outstandingAmount: 0, overdueAmount: 0, autoApplyCredit: 0 },
      });
    if (url === "/settings/invoice") return Promise.resolve({ data: { defaultTerms: "Net 30" } });
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
  fireEvent.click(screen.getByRole("option", { name }));
};
const text = (id: string) => screen.getByTestId(id).textContent ?? "";
const sized = (el: HTMLElement) => el.className;
const BIG = /\btext-3xl\b.*\bfont-bold\b|\bfont-bold\b.*\btext-3xl\b/;

describe("counter total label and size (SA-1066 M8, F7)", () => {
  it("R7: a card sale reads Total, same test id", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(text("running-subtotal")).toContain("$10.00"));
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    expect(screen.getByTestId("running-total")).toHaveTextContent(/^Total\$10\./);
    expect(screen.queryByText("Estimated total")).toBeNull();
  });

  it("R7: a cash tender in progress reads Total, smaller, above Amount due", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(text("running-subtotal")).toContain("$10.00"));
    fireEvent.change(screen.getByLabelText("Amount tendered"), { target: { value: "4" } });
    const running = screen.getByTestId("running-total");
    expect(running).toHaveTextContent(/^Total\$10\./);
    expect(sized(running)).not.toMatch(/text-3xl/);
    expect(sized(screen.getByTestId("change-due"))).toMatch(BIG);
  });

  it("R7a: a card sale's Total is the same size as cash's Amount due", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(text("running-subtotal")).toContain("$10.00"));
    const cashSize = sized(screen.getByTestId("change-due"));
    expect(cashSize).toMatch(BIG);
    fireEvent.click(screen.getByRole("radio", { name: "Card" }));
    expect(sized(screen.getByTestId("running-total"))).toMatch(BIG);
  });

  it("R7a: picking a customer flips the method but the bottom figure stays one size", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    await waitFor(() => expect(text("running-subtotal")).toContain("$10.00"));
    expect(sized(screen.getByTestId("change-due"))).toMatch(BIG);
    pick("Taxed Cafe");
    await waitFor(() => expect(screen.queryByTestId("change-due")).toBeNull());
    expect(sized(screen.getByTestId("running-total"))).toMatch(BIG);
  });
});
