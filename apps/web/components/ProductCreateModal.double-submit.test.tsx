import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

const mutateAsync = jest.fn();

jest.mock("@/lib/api/products", () => ({
  useCreateProduct: () => ({ mutateAsync, isPending: false }),
  useProducts: () => ({ data: { data: [] } }),
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

async function fill() {
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
  await userEvent.type(screen.getByLabelText("Name *"), "Cola");
  await userEvent.type(screen.getByLabelText(/^Unit \*/), "box");
  await userEvent.type(screen.getByLabelText("Price per box *"), "12");
}

beforeEach(() => mutateAsync.mockReset());

describe("ProductCreateModal double submit (B1244)", () => {
  it("posts once for two same-tick submits, and again after a failure releases the guard", async () => {
    let reject!: (e: unknown) => void;
    mutateAsync.mockReturnValueOnce(new Promise((_r, rej) => (reject = rej)));
    await fill();
    const create = screen.getByRole("button", { name: "Create Product" });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.submit(create.closest("form") ?? document.querySelector("form")!);
    fireEvent.submit(document.querySelector("form")!);
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    reject(new Error("409"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));

    mutateAsync.mockResolvedValueOnce({ id: "p1", name: "Cola" });
    fireEvent.click(screen.getByRole("button", { name: "Create Product" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
  });

  it("releases the guard after a validation failure", async () => {
    mutateAsync.mockResolvedValue({ id: "p1", name: "Cola" });
    renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
    await userEvent.type(screen.getByLabelText("Name *"), "Cola");
    await userEvent.type(screen.getByLabelText(/^Unit \*/), "box");
    const form = document.querySelector("form")!;
    fireEvent.submit(form); // no price -> validation return
    expect(mutateAsync).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Price per box *"), "12");
    fireEvent.submit(form);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });
});
