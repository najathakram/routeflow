import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { CounterCustomerMatches, useCustomerListbox } from "./CounterCustomerMatches";

/** R7b 1.2 (c): the customer matches are a listbox the search field drives with the arrow keys. */
const MATCHES = [
  { id: "c1", businessName: "Acme Foods" },
  { id: "c2", businessName: "Acme Supply" },
];

function Harness({ onPick }: { onPick: (c: { id: string }) => void }) {
  const [search, setSearch] = React.useState("acme");
  const { inputProps, listbox } = useCustomerListbox(MATCHES, search, onPick);
  return (
    <div>
      <input
        aria-label="Find customer"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        {...inputProps}
      />
      <CounterCustomerMatches
        search={search}
        matches={MATCHES}
        answered
        disabled={false}
        onPick={onPick}
        listbox={listbox}
      />
    </div>
  );
}

describe("CounterCustomerMatches keyboard", () => {
  it("ArrowDown then Enter picks the first match", () => {
    const onPick = jest.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByLabelText("Find customer");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const first = screen.getByRole("option", { name: "Acme Foods" });
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(MATCHES[0]);
  });

  it("ArrowDown twice then ArrowUp lands on the first; Escape closes the list", () => {
    render(<Harness onPick={jest.fn()} />);
    const input = screen.getByLabelText("Find customer");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "Acme Foods" }).id,
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("a click still picks a match", () => {
    const onPick = jest.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByRole("option", { name: "Acme Supply" }));
    expect(onPick).toHaveBeenCalledWith(MATCHES[1]);
  });
});
