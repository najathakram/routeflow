import * as React from "react";
import { fireEvent, renderWithProviders, screen } from "@/test-utils/render";
import { StandingOrderModal } from "./StandingOrderModal";

/**
 * B1215 C7 on the standing-order (order template) modal: its product search never offers a FAMILY
 * as a line. A family's variants stand in for it, named "<Parent> - <Variant>", and the line
 * added carries that name.
 */

const MINT = {
  id: "v-mint",
  name: "Mint",
  variantName: "Mint",
  kind: "VARIANT",
  parentProductId: "f-pod",
  unit: "each",
  pricePerUnit: "4.00",
  isActive: true,
};
const FAMILY = {
  id: "f-pod",
  name: "Sample Pod",
  kind: "FAMILY",
  parentProductId: null,
  unit: "each",
  pricePerUnit: "0",
  isActive: true,
  variants: [MINT],
};
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [FAMILY] } }),
}));
jest.mock("@/lib/api/order-templates", () => ({
  useCreateOrderTemplate: () => ({ mutate: jest.fn(), isPending: false, reset: jest.fn() }),
  useUpdateOrderTemplate: () => ({ mutate: jest.fn(), isPending: false, reset: jest.fn() }),
}));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

describe("standing order product search (B1215 C7)", () => {
  it("offers the variant under the parent name, never the family, and adds it", async () => {
    renderWithProviders(<StandingOrderModal isOpen onClose={jest.fn()} customerId="c1" />);
    fireEvent.change(screen.getByPlaceholderText("Search products to add…"), {
      target: { value: "pod" },
    });
    const option = await screen.findByRole("button", { name: /Sample Pod - Mint/ });
    expect(screen.queryByRole("button", { name: /^Sample Pod\b(?! -)/ })).not.toBeInTheDocument();
    fireEvent.click(option);
    expect(await screen.findAllByText("Sample Pod - Mint")).not.toHaveLength(0);
    // the search box is cleared by an add, and no family line exists
    expect((screen.getByPlaceholderText("Search products to add…") as HTMLInputElement).value).toBe(
      "",
    );
  });
});
