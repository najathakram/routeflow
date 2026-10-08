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
