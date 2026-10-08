import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
import { ProductCreateModal } from "./ProductCreateModal";

const createAsync = jest.fn();
const putUnits = jest.fn();
const mockEnabled = jest.fn();

jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync: createAsync, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
jest.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "OPERATOR" } }) }));
jest.mock("@/lib/api/product-units", () => ({ useUnitsEnabled: (o: unknown) => mockEnabled(o) }));
jest.mock("@/lib/api/product-units-ladder", () => ({
  putProductUnits: (...a: unknown[]) => putUnits(...a),
  useTenantUnitNames: () => ({
    data: [
      { name: "Bottle", archived: false },
      { name: "Case", archived: false },
      { name: "Pack", archived: false },
    ],
  }),
}));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => null }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => null }));
jest.mock("./SearchableProductPicker", () => ({ SearchableProductPicker: () => null }));
jest.mock("./PackSizePrompt", () => ({ PackSizePrompt: () => null }));

const onCreated = jest.fn();
const onClose = jest.fn();
const mount = () =>
  render(
    <ToastProvider>
      <ProductCreateModal
        isOpen
        onClose={onClose}
        onCreated={onCreated}
        initialName="Soda"
        initialPrice={24}
      />
    </ToastProvider>,
  );
const setUnit = (v: string) =>
  fireEvent.change(screen.getByPlaceholderText("e.g. case, kg, unit"), { target: { value: v } });
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create Product" }));

const stageCase = () => {
  fireEvent.click(screen.getByRole("button", { name: "Set up units" }));
  fireEvent.change(screen.getByLabelText("Smallest unit"), { target: { value: "Bottle" } });
  fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
  fireEvent.change(screen.getByLabelText("Level 1 unit"), { target: { value: "Pack" } });
  fireEvent.change(screen.getByLabelText("How many Bottles in one Pack"), {
    target: { value: "6" },
  });
  fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
  fireEvent.change(screen.getByLabelText("Level 2 unit"), { target: { value: "Case" } });
  fireEvent.change(screen.getByLabelText("How many Packs in one Case"), { target: { value: "4" } });
  fireEvent.change(screen.getByLabelText("Price is for one"), { target: { value: "Case" } });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEnabled.mockReturnValue(true);
  createAsync.mockResolvedValue({ id: "new-1", name: "Soda" });
  putUnits.mockResolvedValue({});
});

describe("ProductCreateModal - units", () => {
  it("flag off: no Set up units row, and the create payload is the one it always was", async () => {
    mockEnabled.mockReturnValue(false);
    const first = mount();
    expect(screen.queryByRole("button", { name: "Set up units" })).toBeNull();
    setUnit("Each");
    submit();
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    const flagOff = createAsync.mock.calls[0][0];
    expect(putUnits).not.toHaveBeenCalled();

    first.unmount();
    jest.clearAllMocks();
    createAsync.mockResolvedValue({ id: "new-2", name: "Soda" });
    mockEnabled.mockReturnValue(true);
    mount();
    setUnit("Each");
    submit();
    await waitFor(() => expect(createAsync).toHaveBeenCalled());
    // no levels staged: byte-identical payload, no PUT
    expect(createAsync.mock.calls[0][0]).toEqual(flagOff);
    expect(putUnits).not.toHaveBeenCalled();
  });

  it("flag on, nothing staged: the quiet row under Units per box, field still editable", () => {
    mount();
    expect(screen.getByTestId("units-setup-section")).toHaveTextContent("Sold in single pieces.");
    expect(screen.getByPlaceholderText("e.g. 12")).toBeEnabled();
  });

  it("staging a Case makes Units per box a read-only sentence, relabels the price, and re-enables when levels go", () => {
    mount();
    stageCase();
    expect(screen.getByText("Case = 24 Bottles (from your units below)")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. 12")).toBeNull();
    expect(screen.getByText("Price per Case *")).toBeInTheDocument();
    // remove both rows
    fireEvent.click(
      within(screen.getByRole("group", { name: "Level 1" })).getByRole("button", {
        name: "Remove",
      }),
    );
    expect(screen.getByPlaceholderText("e.g. 12")).toBeEnabled();
    expect(screen.getByText("Unit *")).toBeInTheDocument();
  });

  it("creates the product, then PUTs the staged ladder once", async () => {
    mount();
    setUnit("Case");
    stageCase();
    submit();
    await waitFor(() => expect(putUnits).toHaveBeenCalledTimes(1));
    expect(createAsync.mock.calls[0][0]).toMatchObject({ unit: "Case", unitsPerBox: 24 });
    expect(putUnits.mock.calls[0][0]).toBe("new-1");
    expect(putUnits.mock.calls[0][1]).toMatchObject({
      baseUnitLabel: "Bottle",
      packLevel: "Case",
      levels: [
        { label: "Pack", perParent: 6, parentLabel: null },
        { label: "Case", perParent: 4, parentLabel: "Pack" },
      ],
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createAsync.mock.invocationCallOrder[0]).toBeLessThan(
      putUnits.mock.invocationCallOrder[0],
    );
  });

  it("a failed units save still finishes the create, with the 'open the product' toast", async () => {
    putUnits.mockRejectedValue(new Error("nope"));
    mount();
    setUnit("Case");
    stageCase();
    await act(async () => {
      submit();
    });
    expect(
      await screen.findByText(
        "Saved the product. The units weren't saved. Open the product to set them up.",
      ),
    ).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("a staged ladder with an error blocks the create and focuses the field", async () => {
    mount();
    setUnit("Case");
    fireEvent.click(screen.getByRole("button", { name: "Set up units" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Add a bigger unit" }));
    submit();
    expect(createAsync).not.toHaveBeenCalled();
    expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
  });

  it("offers the tenant's units first in the Unit field", () => {
    mount();
    fireEvent.focus(screen.getByPlaceholderText("e.g. case, kg, unit"));
    const first = screen
      .getAllByRole("button")
      .filter((b) => ["Bottle", "Case", "Pack"].includes(b.textContent ?? ""));
    expect(first.map((b) => b.textContent)).toEqual(["Bottle", "Case", "Pack"]);
  });
});
