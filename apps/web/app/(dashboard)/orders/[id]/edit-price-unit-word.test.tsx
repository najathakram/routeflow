/**
 * SA-1069 U-2 (row U5): the price field says its unit. On order edit the field was "Unit price" whatever the line
 * sold by, so a line on Case read like a price for one piece. It now reads "Price per <the word the line shows>":
 * the picked unit ("Case"), else the product's pack word ("Box"); a plain each-priced line reads "Price each".
 */
import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import { EditableLineItems, type EditItemState } from "./_components/order-line-edit";

jest.mock("@/lib/api/product-units", () => ({
  useUnitsEnabled: () => false,
  useProductUnits: () => ({ data: undefined }),
}));
jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

const line = (id: string, name: string, over: Partial<EditItemState>): EditItemState => ({
  id,
  originalProductId: `p-${id}`,
  originalProductName: name,
  originalQty: 2,
  productId: `p-${id}`,
  productName: name,
  qty: 2,
  unitPrice: 18,
  basePrice: 18,
  originalUnitPrice: 18,
  cancelled: false,
  unit: "Box",
  unitsPerBox: 12,
  boxSplit: true,
  priceType: "STANDARD",
  ...over,
});

function Harness({ items: initial }: { items: EditItemState[] }) {
  const [items, setItems] = React.useState(initial);
  return (
    <EditableLineItems
      items={items}
      onChange={setItems}
      onAdd={() => {}}
      onDelete={() => {}}
      canEditPrice
      tierPriceFor={() => 18}
      isSpecialTierFor={() => false}
      tierForProductId={() => 1}
      pricingReady
    />
  );
}

const labelsOf = () =>
  screen
    .getAllByRole("textbox")
    .map((el) => el.closest("label")?.firstElementChild?.textContent ?? "")
    .filter((t) => /^Price/.test(t));

describe("order edit: the price field names its unit (SA-1069 U-2, U5)", () => {
  it("U5: a pack line with the default word reads Price per Box, not Unit price", () => {
    renderWithProviders(<Harness items={[line("1", "Corn Chips", {})]} />);
    expect(screen.getByRole("textbox", { name: /^Price per Box/ })).toBeInTheDocument();
    expect(screen.queryByText("Unit price")).toBeNull();
  });

  it("U5: a pack line whose product calls its pack Case reads Price per Case", () => {
    renderWithProviders(<Harness items={[line("1", "Corn Chips", { unit: "Case" })]} />);
    expect(screen.getByRole("textbox", { name: /^Price per Case/ })).toBeInTheDocument();
  });

  it("U5: a line sold by a picked unit reads that unit, not the pack word", () => {
    renderWithProviders(
      <Harness
        items={[
          line("1", "Corn Chips", {
            unit: "Case",
            unitLabel: "Pallet",
            unitsPerBox: 480,
            boxSplit: false,
          }),
        ]}
      />,
    );
    expect(screen.getByRole("textbox", { name: /^Price per Pallet/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Price per Case/ })).toBeNull();
  });

  it("U5: a plain each-priced line reads Price each, and each line reads its own word", () => {
    renderWithProviders(
      <Harness
        items={[
          line("1", "Corn Chips", { unit: "Case" }),
          line("2", "Iced Tea", { unit: "each", unitsPerBox: null, boxSplit: false }),
          line("3", "Loose Rice", { unit: "lb", unitsPerBox: null, boxSplit: false }),
        ]}
      />,
    );
    expect(labelsOf()).toEqual(["Price per Case", "Price each", "Price per lb"]);
    expect(within(document.body).queryByText("Unit price")).toBeNull();
  });
});
