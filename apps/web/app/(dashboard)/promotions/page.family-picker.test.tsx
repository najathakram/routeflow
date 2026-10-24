import * as React from "react";
import { fireEvent, renderWithProviders, screen, within } from "@/test-utils/render";
import PromotionsPage from "./page";

/**
 * B1215 C7 on promotions: the "Specific products" picker never offers a FAMILY (a promotion can
 * only price a sellable product), and a variant reads "<Parent> - <Variant>".
 */

jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api/promotions", () => ({
  ...jest.requireActual("@/lib/api/promotions"),
  usePromotions: () => ({ data: [], isLoading: false, isError: false }),
  useCreatePromotion: () => ({ mutate: jest.fn(), isPending: false }),
  useUpdatePromotion: () => ({ mutate: jest.fn(), isPending: false }),
  useSetPromotionActive: () => ({ mutate: jest.fn(), isPending: false }),
  useDeletePromotion: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({
    data: {
      data: [
        { id: "f-pod", name: "Sample Pod", kind: "FAMILY", parentProductId: null, isActive: true },
        {
          id: "v-mint",
          name: "Mint",
          kind: "VARIANT",
          variantName: "Mint",
          parentProductId: "f-pod",
          parent: { id: "f-pod", name: "Sample Pod" },
          isActive: true,
          pricePerUnit: "4.00",
        },
        {
          id: "p-cola",
          name: "Sample Cola",
          kind: "STANDARD",
          isActive: true,
          pricePerUnit: "2.00",
        },
      ],
    },
  }),
}));

describe("promotion product picker (B1215 C7)", () => {
  it("lists the variant under the parent name and never the family", async () => {
    renderWithProviders(<PromotionsPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "New promotion" })[0]);
    const dialog = await screen.findByRole("dialog");
    const scope = within(dialog)
      .getAllByRole("combobox")
      .find((el) => (el as HTMLSelectElement).querySelector('option[value="PRODUCTS"]'))!;
    fireEvent.change(scope, { target: { value: "PRODUCTS" } });
    expect(
      await within(dialog).findByRole("button", { name: /Sample Pod - Mint/ }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Sample Cola/ })).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: /^Sample Pod\b(?! -)/ }),
    ).not.toBeInTheDocument();
    // a variant is found by its composed name
    fireEvent.change(within(dialog).getByPlaceholderText(/search products by name or sku/i), {
      target: { value: "pod - mint" },
    });
    expect(within(dialog).getByRole("button", { name: /Sample Pod - Mint/ })).toBeInTheDocument();
  });
});
