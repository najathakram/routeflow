import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { RecurringInvoiceForm } from "./RecurringInvoiceForm";

/**
 * B1215 C7 on the recurring-invoice form: the line search never offers a FAMILY as a line. A
 * family's variants stand in for it, named "<Parent> - <Variant>", and the picked row carries the
 * composed description.
 */

const MINT = {
  id: "v-mint",
  name: "Mint",
  variantName: "Mint",
  kind: "VARIANT",
  parentProductId: "f-pod",
  unit: "each",
  pricePerUnit: 4,
  isActive: true,
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  unit: "each",
  pricePerUnit: 0,
  isActive: true,
  variants: [MINT],
};
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [FAMILY] } }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomers: () => ({ data: { data: [] } }),
}));

describe("recurring invoice line search (B1215 C7)", () => {
  it("offers the variant under the parent name and never the family", async () => {
    renderWithProviders(
      <RecurringInvoiceForm
        mode="create"
        onSubmit={jest.fn()}
        isPending={false}
        submitLabel="Save"
      />,
    );
    const input = screen.getByPlaceholderText("Description / product…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "pod" } });
    const option = await screen.findByRole("button", { name: /Sample Pod - Mint/ });
    expect(screen.queryByRole("button", { name: /^Sample Pod\b(?! -)/ })).not.toBeInTheDocument();
    fireEvent.click(option);
    expect(input.value).toBe("Sample Pod - Mint");
  });
});
