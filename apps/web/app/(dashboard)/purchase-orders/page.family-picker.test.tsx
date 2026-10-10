import * as React from "react";
import { render } from "@testing-library/react";
import PurchaseOrdersPage from "./page";

/**
 * B1215 C7 on purchase orders: the product list the PO form picks lines from never contains a
 * FAMILY (a non-stocked, non-purchasable container), and a variant reads "<Parent> - <Variant>".
 */

let seenProducts: Array<{ id: string; name: string }> = [];
jest.mock("../inventory/_components/PurchaseOrdersTab", () => ({
  PurchaseOrdersTab: (props: { products: Array<{ id: string; name: string }> }) => {
    seenProducts = props.products;
    return null;
  },
}));
jest.mock("./ScanPoButton", () => ({ ScanPoButton: () => null }));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/inventory", () => ({
  useSuppliers: () => ({ data: [] }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({
    data: {
      data: [
        { id: "f-pod", name: "Sample Pod", kind: "FAMILY", parentProductId: null },
        {
          id: "v-mint",
          name: "Mint",
          kind: "VARIANT",
          variantName: "Mint",
          parentProductId: "f-pod",
          parent: { id: "f-pod", name: "Sample Pod" },
        },
        { id: "p-cola", name: "Sample Cola", kind: "STANDARD", sku: "C-1" },
      ],
    },
  }),
}));

describe("purchase orders product list (B1215 C7)", () => {
  it("drops the family and names the variant under its parent", () => {
    render(<PurchaseOrdersPage />);
    expect(seenProducts.map((p) => p.id)).toEqual(["v-mint", "p-cola"]);
    expect(seenProducts[0].name).toBe("Sample Pod - Mint");
  });
});
