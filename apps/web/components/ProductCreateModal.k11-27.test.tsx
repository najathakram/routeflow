import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";
import { uploadProductImages } from "@/lib/api/products";

/**
 * K11-27 (F27): Create says it worked, every time.
 *
 * ROOT CAUSE (found with the first red test below): the toast was never the problem. On the products page's
 * "Add variant" path the modal mounts BEFORE its own catalog query lands, and the "pre-fill from the parent"
 * effect was keyed on the parent id alone, so it ran once with no parent to read and never again. Unit and
 * Price stayed blank, the browser's `required` check silently refused the submit, nothing was written, and
 * so no toast could appear. Keying the effect on the parent actually being found fixes the path itself.
 */
const mutateAsync = jest.fn();
const toastSpy = jest.fn();
let products: { data: unknown[] } | undefined;

jest.mock("@routeflow/ui/web", () => {
  const actual = jest.requireActual("@routeflow/ui/web");
  return {
    ...actual,
    useToast: () => {
      const real = actual.useToast();
      return {
        ...real,
        toast: (d: unknown) => {
          toastSpy(d);
          return real.toast(d as never);
        },
      };
    },
  };
});
jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: products }),
  uploadProductImages: jest.fn(),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
  useRegulatedTemplates: () => ({ data: [] }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

const PARENT = {
  id: "par1",
  name: "Acme Widgets",
  unit: "box",
  pricePerUnit: "12.00",
  unitsPerBox: null,
  category: "Misc",
};

const el = (
  <ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} defaultParentId="par1" />
);

/** The "Add variant" path as the products page mounts it: the catalog has not arrived yet. */
function openAddVariantBeforeCatalog() {
  products = undefined;
  const utils = renderWithProviders(el);
  products = { data: [PARENT] };
  utils.rerender(el); // the catalog query lands after the modal is already on screen
  return utils;
}

beforeEach(() => {
  mutateAsync.mockReset();
  toastSpy.mockReset();
  (uploadProductImages as jest.Mock).mockReset();
  mutateAsync.mockResolvedValue({
    id: "v1",
    name: "Strawberry",
    variantName: "Strawberry",
    unit: "box",
    pricePerUnit: "12.00",
    parentProductId: "par1",
    parent: { name: "Acme Widgets" },
  });
  products = { data: [PARENT] };
});

describe("K11-27: Add variant creates and says so", () => {
  it("fills Unit and Price from the parent even when the catalog lands after the modal opened", async () => {
    openAddVariantBeforeCatalog();
    await waitFor(() => expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("box"));
    expect(screen.getByLabelText(/^Price per box/)).toHaveValue(12);
  });

  it("typing only the flavor and pressing Create writes the variant and shows 'Strawberry added to Acme Widgets'", async () => {
    openAddVariantBeforeCatalog();
    await waitFor(() => expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("box"));
    await userEvent.type(screen.getByPlaceholderText(/Chocolate/), "Strawberry");
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        name: "Strawberry",
        parentProductId: "par1",
        unit: "box",
        pricePerUnit: "12.00",
      }),
    );
    expect(await screen.findAllByText("Strawberry added to Acme Widgets")).not.toHaveLength(0);
  });

  it("an operator who edits the pre-filled price keeps it (the late pre-fill never overwrites a typed price)", async () => {
    products = undefined;
    const utils = renderWithProviders(el);
    await userEvent.type(screen.getByLabelText(/^Price per/), "9.5");
    products = { data: [PARENT] };
    utils.rerender(el);
    await waitFor(() => expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("box"));
    expect(screen.getByLabelText(/^Price per box/)).toHaveValue(9.5);
  });
});

describe("K11-27: a late catalog never overwrites what the operator already typed", () => {
  it("a Unit typed before the catalog lands is kept; fields still at their baseline are filled", async () => {
    products = undefined;
    const utils = renderWithProviders(el);
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "pack");
    products = { data: [PARENT] };
    utils.rerender(el);
    // the untouched Price is filled from the parent, so we know the pre-fill ran
    await waitFor(() => expect(screen.getByLabelText(/^Price per/)).toHaveValue(12));
    expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("pack");
  });

  it("an untouched Unit is still filled from the parent when the catalog lands late", async () => {
    openAddVariantBeforeCatalog();
    await waitFor(() => expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("box"));
  });
});

describe("K11-27: one toast per create, held 5 s, variant-aware", () => {
  async function fillStandalone() {
    await userEvent.type(screen.getByLabelText("Name *"), "Cola");
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "box");
    await userEvent.type(screen.getByLabelText("Price per box *"), "12");
  }

  it("a standalone product says '<Name> created' for 5 seconds", async () => {
    mutateAsync.mockResolvedValue({ id: "p1", name: "Cola", unit: "box", pricePerUnit: "12.00" });
    renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
    await fillStandalone();
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    expect(await screen.findAllByText("Cola created")).not.toHaveLength(0);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Cola created", variant: "success", duration: 5000 }),
    );
  });

  it("a variant toast names the variant and its parent, held 5 seconds", async () => {
    openAddVariantBeforeCatalog();
    await waitFor(() => expect(screen.getByLabelText(/^Unit \*/)).toHaveValue("box"));
    await userEvent.type(screen.getByPlaceholderText(/Chocolate/), "Strawberry");
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Strawberry added to Acme Widgets",
        variant: "success",
        duration: 5000,
      }),
    );
  });

  it("a photo upload that fails shows only the warning, in place of the success toast", async () => {
    (uploadProductImages as jest.Mock).mockRejectedValueOnce(new Error("500"));
    mutateAsync.mockResolvedValue({ id: "p1", name: "Cola", unit: "box", pricePerUnit: "12.00" });
    renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
    await fillStandalone();
    const file = new File(["x"], "cola.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Product created, but its photos didn't upload",
        variant: "warning",
      }),
    );
  });

  it("a double-click makes one product and one toast (B1244 holds)", async () => {
    let release!: (v: unknown) => void;
    mutateAsync.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ id: "p1", name: "Cola" }))),
    );
    renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
    await fillStandalone();
    const create = screen.getByRole("button", { name: "Create product" });
    fireEvent.click(create);
    fireEvent.click(create);
    release(undefined);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });
});
