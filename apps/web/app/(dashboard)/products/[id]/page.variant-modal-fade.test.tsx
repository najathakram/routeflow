import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProductDetailPage from "./page";

/**
 * Row 535: closing the variant dialog cleared the variant being edited at once, so during the fade-out the title and
 * the primary button of an EDIT flipped to "Add variant" / "Create Variant". Radix keeps the content mounted while it
 * fades; this suite's Modal stand-in does the same (it renders its title and footer after `open` is false), so the
 * frames the fade shows are the frames asserted.
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
  // Presence-like: the dialog stays mounted (state "closed") after `open` goes false, as during the fade-out.
  Modal: function ModalStandIn({ open, title, footer, children }: any) {
    const everOpen = React.useRef(false);
    if (open) everOpen.current = true;
    if (!everOpen.current) return null;
    return (
      <div role="dialog" data-state={open ? "open" : "closed"}>
        <h2>{title}</h2>
        {children}
        <div>{footer}</div>
      </div>
    );
  },
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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProductDetailPage />
    </QueryClientProvider>,
  );
}

describe("the variant dialog keeps its text while it fades out (row 535)", () => {
  it("closing an EDIT keeps 'Edit variant' / 'Save Changes' (no flip to Add / Create)", () => {
    renderPage();
    fireEvent.click(screen.getByTitle("Edit variant"));
    expect(screen.getByRole("heading", { name: "Edit variant" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("heading", { name: "Edit variant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create Variant" })).toBeNull();
  });

  it("GUARD: reopening as ADD after closing an edit shows Add variant / Create Variant", () => {
    renderPage();
    fireEvent.click(screen.getByTitle("Edit variant"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    expect(screen.getByRole("heading", { name: "Add variant" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Variant" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Chocolate/)).toHaveValue("");
  });
});

// K14 FE1: the page waits for the units v2 flag; these tests are flag-off, so it is known.
jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Pending: () => false,
}));
