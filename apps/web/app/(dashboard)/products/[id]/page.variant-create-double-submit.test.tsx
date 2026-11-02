import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ProductDetailPage from "./page";

/**
 * I-79: a double-click on "Create Variant" sent two POSTs, and the second came back 409 "already exists".
 * The button's `loading` only disables it after React re-renders, so a second click in the same frame still
 * submits. Create is one request per attempt: a second click while the first is unsettled is dropped, and a
 * failed attempt frees the button for a retry. Mounts the real page with children and network mocked.
 */
const createMutate = jest.fn();
const PARENT = {
  id: "p1",
  name: "Acme",
  variantName: null,
  parentProductId: null,
  unit: "each",
  pricePerUnit: "1.00",
  isActive: true,
  images: [],
  variants: [],
};
const current: Record<string, unknown> = PARENT;

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
  useProducts: () => ({ data: { data: [PARENT] } }),
  useUpdateProduct: () => ({ mutate: jest.fn(), isPending: false }),
  useUploadProductImages: () => ({ mutate: jest.fn(), isPending: false }),
  useDeleteProductImage: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateProduct: () => ({ mutate: createMutate, isPending: false }),
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

function openAddVariant(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /add variant/i }));
  fireEvent.change(screen.getByPlaceholderText(/Chocolate/), { target: { value: name } });
}

const createVariant = () => screen.getByRole("button", { name: /create variant/i });

beforeEach(() => createMutate.mockReset());

describe("I-79: product detail variant create sends one request per attempt", () => {
  it("a double-click while the first create is in flight sends one create", () => {
    mount();
    openAddVariant("Berry");
    fireEvent.click(createVariant());
    fireEvent.click(createVariant());
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0][0]).toMatchObject({ name: "Berry", parentProductId: "p1" });
  });

  it("after a failed create, the next click retries", () => {
    createMutate.mockImplementationOnce(
      (_p: unknown, o?: { onError?: (e: unknown) => void; onSettled?: () => void }) => {
        o?.onError?.(new Error("network"));
        o?.onSettled?.();
      },
    );
    mount();
    openAddVariant("Berry");
    fireEvent.click(createVariant());
    fireEvent.click(createVariant());
    expect(createMutate).toHaveBeenCalledTimes(2);
  });
});

/** SA-1082 A-4: the form opens filled with the family's prices. A box the person clears is sent as nothing. */
describe("SA-1082 A-4: the Add variant form's tier prices", () => {
  const TIERS = ["priceTier2", "priceTier3", "priceTier4", "priceTier5"];
  const LABELS = ["T2", "T3", "T4", "T5"];
  const sent = () => createMutate.mock.calls[0][0] as Record<string, unknown>;
  const typeIn = (label: string, value: string) =>
    fireEvent.change(
      screen.getByText(label).parentElement!.querySelector("input") as HTMLInputElement,
      { target: { value } },
    );
  const clearTiers = () => LABELS.forEach((label) => typeIn(label, ""));

  afterEach(() => {
    delete current.priceTier2;
  });

  it("VM-13: every box cleared sends the family's Retail and no tier", () => {
    mount();
    openAddVariant("Berry");
    typeIn("T1 (List)", "");
    clearTiers();
    fireEvent.click(createVariant());
    expect(sent().pricePerUnit).toBe("1.00");
    expect(TIERS.map((t) => sent()[t])).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("VM-13: a tier typed under a cleared Retail is sent, and the cleared ones are not", () => {
    mount();
    openAddVariant("Berry");
    typeIn("T1 (List)", "");
    clearTiers();
    typeIn("T3", "0.75");
    fireEvent.click(createVariant());
    expect(TIERS.map((t) => sent()[t])).toEqual([undefined, "0.75", undefined, undefined]);
  });

  it("VM-14: a typed Retail with cleared tiers still fills them, so it never takes the family's tier", () => {
    mount();
    openAddVariant("Berry");
    typeIn("T1 (List)", "30");
    clearTiers();
    fireEvent.click(createVariant());
    expect(sent().pricePerUnit).toBe("30");
    expect(TIERS.map((t) => sent()[t])).toEqual(["30", "30", "30", "30"]);
  });

  it("GUARD: the form as it opens sends the family's prices it shows", () => {
    current.priceTier2 = "0.90";
    mount();
    openAddVariant("Berry");
    fireEvent.click(createVariant());
    expect(sent().pricePerUnit).toBe("1");
    expect(sent().priceTier2).toBe("0.9");
  });
});

// K14 FE1: the page waits for the units v2 flag; these tests are flag-off, so it is known.
jest.mock("@/lib/api/units-v2", () => ({
  ...jest.requireActual("@/lib/api/units-v2"),
  usePricesV2Pending: () => false,
}));
