import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProductDetailPage from "./page";

/**
 * B1: the variant name is stored BARE. The detail page's save, Make-variant and Link-existing used to send
 * `name = "<parent> - <variantName>"`; the server copies an incoming name into `variantName`, so every edit
 * re-prefixed it ("Acme - Acme - Classic"). Mounts the real page (children and network mocked) and asserts on the
 * PATCH payload the page hands to the update mutation.
 */
const mutate = jest.fn();
const PARENT = { id: "p1", name: "Acme", parentProductId: null, unit: "each", isActive: true };
const VARIANT = {
  id: "v1",
  name: "Classic",
  variantName: "Classic",
  parentProductId: "p1",
  parent: { id: "p1", name: "Acme" },
  unit: "each",
  pricePerUnit: "1.00",
  isActive: true,
  images: [],
  variants: [],
};
const STANDALONE = {
  id: "s1",
  name: "Old Standalone",
  variantName: null,
  parentProductId: null,
  unit: "each",
  pricePerUnit: "1.00",
  isActive: true,
  images: [],
  variants: [],
};
let current: Record<string, unknown> = VARIANT;

jest.mock("next/navigation", () => ({
  useParams: () => ({ id: (current as { id: string }).id }),
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
  useProduct: () => ({ data: current, isLoading: false }),
  useProducts: () => ({ data: { data: [PARENT, VARIANT, STANDALONE] } }),
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

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProductDetailPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mutate.mockReset();
  // Chain like the real mutation: the first PATCH's onSuccess fires the next step.
  mutate.mockImplementation((_payload: unknown, opts?: { onSuccess?: () => void }) =>
    opts?.onSuccess?.(),
  );
});
// The sticky edit bar renders its own Save; target the header one.
const headerSave = () =>
  screen
    .getAllByRole("button", { name: /^save/i })
    .find((b) => !b.closest('[data-testid="sticky-edit-bar"]'))!;

const payloads = () => mutate.mock.calls.map((c) => c[0] as Record<string, unknown>);

describe("B1: product detail variant save sends the bare name", () => {
  it("saving an edited variant sends a name that carries no parent prefix", () => {
    current = VARIANT;
    mount();
    fireEvent.click(screen.getAllByTitle("Edit product")[0]);
    fireEvent.click(headerSave());
    expect(mutate).toHaveBeenCalledTimes(1);
    const payload = mutate.mock.calls[0][0] as { id: string; name: string };
    expect(payload.id).toBe("v1");
    expect(payload.name).toBe("Classic");
    expect(payload.name).not.toMatch(/^Acme - /);
  });

  it("saving a variant twice in a row sends the same bare name both times", () => {
    current = VARIANT;
    mount();
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getAllByTitle("Edit product")[0]);
      fireEvent.click(headerSave());
    }
    expect(payloads().map((p) => p.name)).toEqual(["Classic", "Classic"]);
  });

  it("Make variant sends the bare flavor as name and variantName", () => {
    current = STANDALONE;
    mount();
    fireEvent.click(screen.getByRole("button", { name: /make variant of/i }));
    const select = document.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "p1" } });
    fireEvent.change(screen.getByPlaceholderText(/Chocolate/), { target: { value: "Berry" } });
    fireEvent.click(screen.getByRole("button", { name: /link as variant/i }));
    expect(payloads()).toEqual([
      { id: "s1", parentProductId: "p1", variantName: "Berry", name: "Berry" },
    ]);
  });

  it("Make variant with a name for the parent never composes either name", () => {
    current = STANDALONE;
    mount();
    fireEvent.click(screen.getByRole("button", { name: /make variant of/i }));
    fireEvent.change(document.querySelector("select") as HTMLSelectElement, {
      target: { value: "p1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Chocolate/), { target: { value: "Berry" } });
    fireEvent.change(screen.getByPlaceholderText(/Original/), { target: { value: "Original" } });
    fireEvent.click(screen.getByRole("button", { name: /link as variant/i }));
    expect(payloads()).toEqual([
      { id: "p1", variantName: "Original" },
      { id: "s1", parentProductId: "p1", variantName: "Berry", name: "Berry" },
    ]);
  });

  it("Link existing sends the bare flavor for the adopted product", () => {
    current = {
      ...PARENT,
      variantName: "Original",
      images: [],
      variants: [],
      pricePerUnit: "1.00",
    };
    mount();
    fireEvent.click(screen.getByRole("button", { name: /link existing/i }));
    fireEvent.click(screen.getByText("Old Standalone"));
    fireEvent.change(screen.getByPlaceholderText(/Chocolate/), { target: { value: "Mint" } });
    fireEvent.click(screen.getByRole("button", { name: /link as variant/i }));
    expect(payloads()).toEqual([
      { id: "s1", parentProductId: "p1", variantName: "Mint", name: "Mint" },
    ]);
  });
});

// K14 FE1: the page waits for the units v2 flag; these tests are flag-off, so it is known.
jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Pending: () => false,
}));
