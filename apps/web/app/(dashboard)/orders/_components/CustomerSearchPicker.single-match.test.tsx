import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CustomerSearchPicker } from "./CustomerSearchPicker";

/**
 * apple-ux r5 N03: with exactly ONE customer match the row is already active (aria-activedescendant set), so Enter
 * picks it. Two or more matches still start with nothing highlighted: Enter must never choose between customers.
 */
const ACME = { id: "c1", businessName: "Acme Market", contactName: "Ann" };
const DELI = { id: "c2", businessName: "Acme Deli", contactName: "Bo" };

function setup(results: Array<typeof ACME>) {
  const onPick = jest.fn();
  render(
    <CustomerSearchPicker
      value="acme"
      onValueChange={() => {}}
      results={results}
      searched
      listOpen
      onListOpenChange={() => {}}
      onPick={onPick}
      inputRef={React.createRef()}
    />,
  );
  return { onPick, input: screen.getByRole("combobox", { name: /search customers/i }) };
}

describe("customer search with a single match (N03)", () => {
  it("makes the only match active, so Enter picks it", () => {
    const { onPick, input } = setup([ACME]);
    const option = screen.getByRole("option", { name: /Acme Market/ });
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    expect(option).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(ACME);
  });

  it("leaves nothing active with two matches (Enter picks nothing)", () => {
    const { onPick, input } = setup([ACME, DELI]);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("leaves nothing active when there is no match", () => {
    const { onPick, input } = setup([]);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });
});
