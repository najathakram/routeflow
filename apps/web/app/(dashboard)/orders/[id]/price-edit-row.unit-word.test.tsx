import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { PriceEditRow } from "./price-edit-row";

/** SA-1069 U-2: `unitWord` is required, and the price field is named "Price per <word>" (a plain each line: "Price each"). */

function Row({ unitWord }: { unitWord: string }) {
  const [price, setPrice] = React.useState(10);
  return (
    <PriceEditRow
      basePrice={12}
      unitPrice={price}
      unitWord={unitWord}
      onPriceChange={setPrice}
      onReasonChange={() => {}}
    />
  );
}

describe("PriceEditRow unitWord (SA-1069 U-2)", () => {
  it("names the price field after the unit it is quoted per", () => {
    renderWithProviders(<Row unitWord="Case" />);
    expect(screen.getByRole("textbox", { name: /^Price per Case/ })).toBeInTheDocument();
    expect(screen.queryByText("Unit price")).toBeNull();
  });

  it.each([["each"], ["unit"], ["Each"]])("%s reads Price each, never Price per each", (word) => {
    renderWithProviders(<Row unitWord={word} />);
    expect(screen.getByRole("textbox", { name: /^Price each/ })).toBeInTheDocument();
    expect(screen.queryByText(/per each|per unit/i)).toBeNull();
  });

  it("leaves the $ off field and the typing behaviour as they were", () => {
    renderWithProviders(<Row unitWord="Box" />);
    expect(screen.getByText("$ off / unit")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Price per Box/ })).toHaveValue("10.00");
  });
});
