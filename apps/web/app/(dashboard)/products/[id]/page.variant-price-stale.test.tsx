import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProductDetailPage from "./page";

/**
 * REG (units v2, money): the legacy parent's variant modal always sent the variant's list price and all four tiers
 * from the variant the PARENT's cached product embeds. A v2 save on that variant does not update the parent's
 * cache, so renaming the variant from the parent wrote the pre-save price back. The modal now sends only a price the
 * operator changed (against the strings it was seeded with); a tier moves only through the ladder rule.
 */
const mutate = jest.fn();
const VARIANT = {
  id: "v1",
  name: "Classic",
  variantName: "Classic",
  sku: "V-1",
  parentProductId: "p1",
  unit: "each",
  pricePerUnit: "10.00",
  priceTier2: "9.00",
  priceTier3: "8.00",
  priceTier4: "0.00",
  priceTier5: "0.00",
  isActive: true,
  images: [],
  variants: [],
};
const PARENT = {
  id: "p1",
  name: "Acme",
  parentProductId: null,
  unit: "each",
  pricePerUnit: "10.00",
  priceTier2: "9.00",
  priceTier3: "8.00",
  priceTier4: "0.00",
  priceTier5: "0.00",
  isActive: true,
  kind: "STANDALONE",
  images: [],
  variants: [VARIANT],
};

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}));
jest.mock("next/link", () => ({ __esModule: true, default: (p: any) => <a {...p} /> }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { role: "OPERATOR" } }),
  useOptionalAuth: () => ({ user: { role: "OPERATOR" } }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProduct: () => ({ data: PARENT, isLoading: false }),
  useProducts: () => ({ data: { data: [PARENT, VARIANT] } }),
  useUpdateProduct: () => ({ mutate, isPending: false }),
  useUploadProductImages: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteProductImage: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateProduct: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/cost-history", () => ({ useCostHistory: () => ({ data: [] }) }));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));
jest.mock("@/lib/api/tobacco", () => ({
  TOBACCO_ADDON: "tobacco",
  useHasAddon: () => false,
}));
jest.mock("@/lib/api/addons", () => ({ MSRP_ADDON: "msrp" }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: [] }), patch: jest.fn() },
}));

const PRICE_KEYS = ["pricePerUnit", "priceTier2", "priceTier3", "priceTier4", "priceTier5"];

function openVariantModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProductDetailPage />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByTitle("Edit variant"));
  return screen.getByPlaceholderText(/Chocolate/).closest("[role='dialog']") as HTMLElement;
}

beforeEach(() => {
  mutate.mockReset();
});

describe("the variant modal never restores a stale variant price", () => {
  it("REG: renaming a variant sends no price key", () => {
    const modal = openVariantModal();
    fireEvent.change(screen.getByPlaceholderText(/Chocolate/), { target: { value: "Classic 2" } });
    fireEvent.click(within(modal).getByRole("button", { name: "Save Changes" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0][0] as Record<string, unknown>;
    expect(body.id).toBe("v1");
    expect(body.variantName).toBe("Classic 2");
    for (const k of PRICE_KEYS) expect(body[k]).toBeUndefined();
  });

  it("a changed variant list price is sent, with only the tiers the ladder moves", () => {
    const modal = openVariantModal();
    const list = within(modal).getAllByDisplayValue("10")[0];
    fireEvent.change(list, { target: { value: "12" } });
    fireEvent.click(within(modal).getByRole("button", { name: "Save Changes" }));
    const body = mutate.mock.calls[0][0] as Record<string, unknown>;
    expect(body.pricePerUnit).toBe("12");
    // 9, 8 sit below the old list and 0 follows it: nothing else moves.
    for (const k of PRICE_KEYS.slice(1)) expect(body[k]).toBeUndefined();
  });
});
