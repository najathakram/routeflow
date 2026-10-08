import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { UnitCombobox } from "./UnitCombobox";

function Box(props: Partial<React.ComponentProps<typeof UnitCombobox>>) {
  const [v, setV] = React.useState("");
  return <UnitCombobox value={v} onChange={setV} {...props} />;
}
const names = () => screen.getAllByRole("button").map((o) => o.textContent);

describe("UnitCombobox - tenant units first", () => {
  it("suggests the tenant's units first, then the common list, de-duplicated case-insensitively", () => {
    render(<Box tenantUnits={["Crate", "Case"]} />);
    fireEvent.focus(screen.getByRole("textbox"));
    const list = names();
    expect(list.slice(0, 2)).toEqual(["Crate", "Case"]);
    expect(list.filter((n) => (n ?? "").toLowerCase() === "case")).toHaveLength(1);
    expect(list).toContain("pallet");
  });

  it("without tenantUnits the list is today's alphabetical one", () => {
    render(<Box />);
    fireEvent.focus(screen.getByRole("textbox"));
    const list = names();
    expect(list).toEqual([...list].sort());
  });
});

describe("UnitCombobox - keyboard", () => {
  const open = () => {
    render(<Box tenantUnits={["Crate", "Case"]} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    return input;
  };

  it("ArrowDown/ArrowUp move through the options and Enter picks the highlighted one", () => {
    const input = open();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("button")[1]).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("button")[0]).toHaveAttribute("data-active", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("Case");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("Escape closes the list and every option has an accessible name", () => {
    const input = open();
    for (const b of screen.getAllByRole("button")) expect(b).toHaveAccessibleName();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("ArrowDown reopens a closed list", () => {
    const input = open();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("button")[0]).toHaveAttribute("data-active", "true");
  });
});
