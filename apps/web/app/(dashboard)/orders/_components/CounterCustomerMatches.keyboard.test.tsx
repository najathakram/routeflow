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

  it("names its keys while the list is open and drops the line when Escape closes it", () => {
    render(<Harness onPick={jest.fn()} />);
    expect(screen.getByTestId("counter-customer-keys")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Find customer"), { key: "Escape" });
    expect(screen.queryByTestId("counter-customer-keys")).toBeNull();
  });

  it("the key hint is a described, large-screen-only line with hidden glyphs", () => {
    render(<Harness onPick={jest.fn()} />);
    const input = screen.getByLabelText("Find customer");
    const hint = screen.getByTestId("counter-customer-keys");
    expect(hint.id).not.toBe("");
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
    expect(hint.className).toContain("hidden");
    expect(hint.className).toContain("lg:block");
    expect(hint.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(hint.querySelector(".sr-only")?.textContent).toBe(
      "Up and down arrows to choose, Enter to pick",
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("no hint while the list is disabled", () => {
    render(
      <CounterCustomerMatches
        search="acme"
        matches={MATCHES}
        answered
        disabled
        onPick={jest.fn()}
        listbox={
          {
            id: "l",
            keysId: "k",
            open: true,
            active: -1,
            optionId: (i: number) => `o${i}`,
          } as never
        }
      />,
    );
    expect(screen.queryByTestId("counter-customer-keys")).toBeNull();
  });

  it("a click still picks a match", () => {
    const onPick = jest.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByRole("option", { name: "Acme Supply" }));
    expect(onPick).toHaveBeenCalledWith(MATCHES[1]);
  });
});
