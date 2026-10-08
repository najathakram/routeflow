import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { createTestQueryClient } from "@/test-utils/render";
import { ProductUnitsCard, type UnitsCardProduct } from "./ProductUnitsCard";

const replaceMutate = jest.fn();
let mockUnits: unknown[] = [];

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => true,
  useProductUnits: () => ({
    data: mockUnits,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useCreateProductUnit: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdateProductUnit: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
  useDeleteProductUnit: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/product-units-ladder", () => ({
  useReplaceProductUnits: () => ({ mutate: replaceMutate, isPending: false }),
  useTenantUnitNames: () => ({
    data: [
      { name: "Bottle", archived: false },
      { name: "Case", archived: false },
      { name: "Pack", archived: false },
    ],
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));

const plain: UnitsCardProduct = { id: "p1", unit: "Each", unitsPerBox: null, pricePerUnit: "2.00" };
const boxed: UnitsCardProduct = { id: "p2", unit: "Box", unitsPerBox: 12, pricePerUnit: "24.00" };
const lvl = (o: Record<string, unknown>) => ({
  id: "u1",
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
  ...o,
});

const queryClient = createTestQueryClient();
const renderCard = (product: UnitsCardProduct) =>
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ProductUnitsCard product={product} />
      </ToastProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockUnits = [];
});

describe("ProductUnitsCard - the collapsed 'Set up units' row", () => {
  it("nothing set up and no pack: 'Sold in single pieces.' + Set up units", () => {
    renderCard(plain);
    expect(screen.getByTestId("units-setup-section")).toHaveTextContent("Sold in single pieces.");
    expect(screen.getByRole("button", { name: "Set up units" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("nothing set up with a pack: 'Sold by the box (12 pieces) and by the piece.'", () => {
    renderCard(boxed);
    expect(screen.getByTestId("units-setup-section")).toHaveTextContent(
      "Sold by the box (12 pieces) and by the piece.",
    );
  });

  it("set up: the chain summary + Edit units", () => {
    mockUnits = [lvl({ id: "a", label: "Pack", factorToBase: 6, perParent: 6 })];
    renderCard({ ...boxed, unitsPerBox: 24, baseUnitLabel: "Bottle", packLabel: "Case" });
    expect(screen.getByTestId("units-setup-section")).toHaveTextContent(
      "1 Case = 4 Packs = 24 Bottles",
    );
    expect(screen.getByRole("button", { name: "Edit units" })).toBeInTheDocument();
  });

  it("the legacy card content is untouched while the editor is closed", () => {
    renderCard(boxed);
    expect(screen.getByText(/No other units yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add unit" })).toBeInTheDocument();
  });
});

describe("ProductUnitsCard - the ladder editor", () => {
  it("opens and closes without a page jump (the region is always mounted)", () => {
    renderCard(plain);
    const region = document.getElementById("product-units-editor") as HTMLElement;
    expect(region).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up units" }));
    expect(screen.getByRole("group", { name: "How is this sold?" })).toBeInTheDocument();
    expect(document.getElementById("product-units-editor")).toBe(region);
    expect(screen.getByRole("button", { name: "Set up units" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Set up units" }));
    expect(screen.queryByRole("group", { name: "How is this sold?" })).toBeNull();
  });

  const fillChain = () => {
    fireEvent.click(screen.getByRole("button", { name: "Set up units" }));
    fireEvent.change(screen.getByLabelText("Smallest unit"), { target: { value: "Bottle" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
    fireEvent.change(screen.getByLabelText("Level 1 unit"), { target: { value: "Pack" } });
    fireEvent.change(screen.getByLabelText("How many Bottles in one Pack"), {
      target: { value: "6" },
    });
  };

  it("Save sends ONE PUT with the chain and closes on success", () => {
    replaceMutate.mockImplementation((_b, o) => o.onSuccess());
    renderCard(plain);
    fillChain();
    fireEvent.click(screen.getByRole("button", { name: "Save units" }));
    expect(replaceMutate).toHaveBeenCalledTimes(1);
    expect(replaceMutate.mock.calls[0][0]).toMatchObject({
      baseUnitLabel: "Bottle",
      levels: [{ label: "Pack", perParent: 6, parentLabel: null, sortOrder: 0 }],
    });
    expect(screen.queryByRole("group", { name: "How is this sold?" })).toBeNull();
  });

  it("a blocked Save sends nothing and shows the error on the field (no toast copy)", () => {
    renderCard(plain);
    fireEvent.click(screen.getByRole("button", { name: "Set up units" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save units" }));
    expect(replaceMutate).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it("maps the used-size 409 (status + exact text) under its row and offers 'Add a new unit instead'", () => {
    const text =
      '"Pack" is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.';
    replaceMutate.mockImplementation((_b, o) =>
      o.onError({ response: { status: 409, data: { message: text } } }),
    );
    renderCard(plain);
    fillChain();
    fireEvent.click(screen.getByRole("button", { name: "Save units" }));
    const row = screen.getByRole("group", { name: "Level 1" });
    expect(within(row).getByText(text)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Add a new unit instead" })).toBeInTheDocument();
    // the editor stays open and the input is kept
    expect(screen.getByLabelText("How many Bottles in one Pack")).toHaveValue("6");
  });

  it("a lock timeout (503) shows the retry copy and keeps the entry", () => {
    replaceMutate.mockImplementation((_b, o) => o.onError({ response: { status: 503, data: {} } }));
    renderCard(plain);
    fillChain();
    fireEvent.click(screen.getByRole("button", { name: "Save units" }));
    expect(
      screen.getByText("Couldn't check that code right now. Your entry is still here. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("How many Bottles in one Pack")).toHaveValue("6");
  });
});
