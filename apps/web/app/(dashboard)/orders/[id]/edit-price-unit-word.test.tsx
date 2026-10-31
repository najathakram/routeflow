/**
 * SA-1069 U-2 (row U5): the price field says its unit. On order edit the field was "Unit price" whatever the line
 * sold by, so a line on Case read like a price for one piece. It now reads "Price per <the word the line shows>":
 * the picked unit ("Case"), else the product's pack word ("Box"); a plain each-priced line reads "Price each".
 */
import * as React from "react";
import userEvent from "@testing-library/user-event";
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
// What the Substitute picker offers: the products a clerk can swap a line to.
const mockSubstitutes = [
  { id: "s-apples", name: "Loose Apples", unit: "lb", unitsPerBox: null, pricePerUnit: 2 },
  { id: "s-water", name: "Tray Water", unit: "Tray", unitsPerBox: 6, pricePerUnit: 9 },
  { id: "s-soap", name: "Single Soap", unit: "each", unitsPerBox: null, pricePerUnit: 3 },
  { id: "s-cola", name: "Case Cola", unit: "Case", unitsPerBox: 24, pricePerUnit: 30 },
];
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: mockSubstitutes } }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn() } }));

/** A stored line as buildEditItemFromLine seeds it: the unit words and their `original*` copies agree. */
const line = (id: string, name: string, over: Partial<EditItemState>): EditItemState => {
  const state: EditItemState = {
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
  };
  return {
    ...state,
    originalUnit: state.unit,
    originalPackUnit: state.packUnit ?? state.unit,
    originalPackUnitsPerBox: state.packUnitsPerBox ?? state.unitsPerBox,
    originalUnitLabel: state.unitLabel,
  };
};

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

  // The product's pack word and size decide the word, not the stored default: a pack whose product says each reads the
  // default pack word, and an each pack of 1 is a plain each line (reviewer mutation gaps E and F).
  it("a pack of 12 whose product says each reads Price per Box; an each pack of 1 reads Price each", () => {
    renderWithProviders(
      <Harness
        items={[
          line("1", "Corn Chips", { unit: "each", unitsPerBox: 12 }),
          line("2", "Iced Tea", { unit: "each", unitsPerBox: 1, boxSplit: false }),
        ]}
      />,
    );
    expect(labelsOf()).toEqual(["Price per Box", "Price each"]);
  });
});

/** Click Substitute on the first line, pick the product named `pick`; return the price-field labels afterwards. */
async function substituteTo(user: ReturnType<typeof userEvent.setup>, pick: string) {
  await user.click(screen.getAllByRole("button", { name: "Substitute" })[0]);
  await user.click(await screen.findByRole("button", { name: new RegExp(pick) }));
  return labelsOf();
}

describe("order edit: a substituted line's price field follows the substitute (SA-1069 U-2)", () => {
  const caseOf12 = () => <Harness items={[line("1", "Corn Chips", { unit: "Case" })]} />;

  it.each([
    ["Loose Apples", "Price per lb"],
    ["Tray Water", "Price per Tray"],
    ["Single Soap", "Price each"],
  ])("a Case of 12 swapped to %s reads %s", async (pick, want) => {
    const user = userEvent.setup();
    renderWithProviders(caseOf12());
    expect(labelsOf()).toEqual(["Price per Case"]);
    expect(await substituteTo(user, pick)).toEqual([want]);
  });

  it("an each line of 1 swapped to a Case of 24 reads Price per Case, not Price each", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Harness
        items={[line("1", "Iced Tea", { unit: "each", unitsPerBox: null, boxSplit: false })]}
      />,
    );
    expect(labelsOf()).toEqual(["Price each"]);
    expect(await substituteTo(user, "Case Cola")).toEqual(["Price per Case"]);
  });

  it("a line sold by a picked unit leaves that unit behind with the product it replaced", async () => {
    const user = userEvent.setup();
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
    expect(labelsOf()).toEqual(["Price per Pallet"]);
    expect(await substituteTo(user, "Loose Apples")).toEqual(["Price per lb"]);
  });

  it("Undo brings the replaced product's word back", async () => {
    const user = userEvent.setup();
    renderWithProviders(caseOf12());
    expect(await substituteTo(user, "Loose Apples")).toEqual(["Price per lb"]);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(labelsOf()).toEqual(["Price per Case"]);
  });

  it("Undo on a picked-unit line brings the picked unit back", async () => {
    const user = userEvent.setup();
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
    await substituteTo(user, "Tray Water");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(labelsOf()).toEqual(["Price per Pallet"]);
  });
});
