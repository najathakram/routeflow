import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CustomerSearchPicker } from "./CustomerSearchPicker";

/**
 * W-1041 (SA-1062 MUST 5): the builder's empty search offers `Add "<typed>" as a new customer` through the optional
 * `onCreateNew` prop. Without the prop (every other mount) the empty answer is the plain "No customers found." line.
 */
function setup(props: { onCreateNew?: (name: string) => void; results?: unknown[] }) {
  render(
    <CustomerSearchPicker
      value="Acme Cafe"
      onValueChange={() => {}}
      results={(props.results ?? []) as never[]}
      searched
      listOpen
      onListOpenChange={() => {}}
      onPick={() => {}}
      onCreateNew={props.onCreateNew}
      inputRef={React.createRef()}
    />,
  );
}

describe("CustomerSearchPicker: Add as a new customer (W-1041)", () => {
  it("offers the typed name as a new customer and hands it back on a tap", () => {
    const onCreateNew = jest.fn();
    setup({ onCreateNew });
    const add = screen.queryByRole("button", { name: 'Add "Acme Cafe" as a new customer' });
    expect(add).toBeInTheDocument();
    fireEvent.click(add!);
    expect(onCreateNew).toHaveBeenCalledWith("Acme Cafe");
  });

  it("guard: no button when the search found someone, or when the mount passes no onCreateNew", () => {
    setup({ onCreateNew: jest.fn(), results: [{ id: "c1", businessName: "Acme Cafe" }] });
    expect(screen.queryByRole("button", { name: /as a new customer/ })).toBeNull();
  });

  it("guard: no button without the prop", () => {
    setup({});
    expect(screen.getByText("No customers found.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /as a new customer/ })).toBeNull();
  });
});
