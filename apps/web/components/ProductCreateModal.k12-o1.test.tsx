import * as React from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { ProductCreateModal } from "./ProductCreateModal";

/**
 * K12 O1 (A4 lost input), New product: a count typed into the pack-size prompt and created with "Create product" (never
 * "Set pack size") must be sent, not dropped behind a "created" toast. A pre-filled suggestion alone is never sent.
 */
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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("./CategoryCombobox", () => ({ CategoryCombobox: () => <div /> }));
jest.mock("./SubcategoryCombobox", () => ({ SubcategoryCombobox: () => <div /> }));
jest.mock("./BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue({ id: "p1", name: "Cola", unit: "box", pricePerUnit: "12.00" });
});

async function fillAndCreate(typeInPrompt?: string) {
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Cola" } });
  fireEvent.change(screen.getByLabelText(/^Unit \*/), { target: { value: "box" } });
  fireEvent.change(screen.getByLabelText(/^Price per/), { target: { value: "12" } });
  // The prompt's own box, not the form's Pieces per box field.
  const prompt = within(screen.getByText(/^How many .* in a box\?$/).closest("div")!).getByRole(
    "spinbutton",
  );
  if (typeInPrompt !== undefined) fireEvent.change(prompt, { target: { value: typeInPrompt } });
  fireEvent.click(screen.getByRole("button", { name: "Create product" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(mutateAsync).toHaveBeenCalledTimes(1);
  return mutateAsync.mock.calls[0][0] as Record<string, unknown>;
}

it("sends a count typed into the prompt with Create product", async () => {
  expect((await fillAndCreate("12")).unitsPerBox).toBe(12);
});

it("sends no pack size when nothing was typed in the prompt", async () => {
  expect((await fillAndCreate()).unitsPerBox).toBeUndefined();
});

it("sends no pack size once the prompt is dismissed, even with a typed count", async () => {
  renderWithProviders(<ProductCreateModal isOpen onClose={jest.fn()} onCreated={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Cola" } });
  fireEvent.change(screen.getByLabelText(/^Unit \*/), { target: { value: "box" } });
  fireEvent.change(screen.getByLabelText(/^Price per/), { target: { value: "12" } });
  const box = within(screen.getByText(/^How many .* in a box\?$/).closest("div")!).getByRole(
    "spinbutton",
  );
  fireEvent.change(box, { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "Dismiss pack-size suggestion" }));
  fireEvent.click(screen.getByRole("button", { name: "Create product" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(mutateAsync.mock.calls[0][0].unitsPerBox).toBeUndefined();
});
