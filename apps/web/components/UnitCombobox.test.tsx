import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { UnitCombobox } from "./UnitCombobox";

/** W2a: the combobox offers the whole shared COMMON_UNITS list, merged with the catalog's own units. */
describe("UnitCombobox", () => {
  it("offers the common units on focus, including the four the product page used to miss", () => {
    render(<UnitCombobox value="" onChange={jest.fn()} />);
    fireEvent.focus(screen.getByRole("textbox"));
    for (const u of ["each", "case", "pcs", "bundle", "liter", "strip"]) {
      expect(screen.getByRole("button", { name: u })).toBeInTheDocument();
    }
  });

  it("merges the catalog's extra units, de-duplicated", () => {
    render(<UnitCombobox value="" onChange={jest.fn()} extraUnits={["case", "firkin"]} />);
    fireEvent.focus(screen.getByRole("textbox"));
    expect(screen.getAllByRole("button", { name: "case" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "firkin" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(24); // 23 common + 1 extra
  });
});
