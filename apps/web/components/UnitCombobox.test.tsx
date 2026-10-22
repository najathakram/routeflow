import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * V01 (repro): the demo bug was a native closed <select> whose per-keystroke change event rebuilt the grid, so
 * typing "Can" picked Case, then "Add new unit", and the "n" landed in the new-unit box. The unit field here is
 * a text combobox with no such rebuild. These pin that: fast typing keeps every character in the one field.
 */
describe("UnitCombobox fast typing (V01)", () => {
  function Controlled({ onValue }: { onValue?: (v: string) => void }) {
    const [value, setValue] = React.useState("");
    return (
      <div>
        <UnitCombobox
          id="u"
          value={value}
          onChange={(v) => {
            setValue(v);
            onValue?.(v);
          }}
        />
        <input type="text" aria-label="other" defaultValue="" />
      </div>
    );
  }

  it("typing 'Can' with no delay ends on 'Can', in the same field, with nothing else touched", async () => {
    const seen: string[] = [];
    render(<Controlled onValue={(v) => seen.push(v)} />);
    const unit = document.getElementById("u") as HTMLInputElement;
    await userEvent.type(unit, "Can");
    expect(unit.value).toBe("Can");
    expect(seen).toEqual(["C", "Ca", "Can"]); // every keystroke is a plain prefix, never a jump to another unit
    expect(document.activeElement).toBe(unit);
    expect(screen.getByLabelText("other")).toHaveValue("");
    expect(screen.queryByText(/new unit/i)).toBeNull();
    expect(screen.queryByRole("textbox", { name: /new unit/i })).toBeNull();
  });

  it("a custom unit that matches nothing only shows the confirm hint, never a second input", async () => {
    render(<Controlled />);
    const unit = document.getElementById("u") as HTMLInputElement;
    await userEvent.type(unit, "Zzzq");
    expect(unit.value).toBe("Zzzq");
    expect(document.querySelectorAll("input[type=text]")).toHaveLength(2); // the unit field and the probe
  });
});

/** K13 F07 / K12 F06: the list closes on every way of finishing, and "Case" + "case" is one suggestion. */
describe("UnitCombobox closing and de-duplication (K13 F07)", () => {
  function Controlled({ extra }: { extra?: string[] }) {
    const [value, setValue] = React.useState("");
    return (
      <div>
        <UnitCombobox id="u" value={value} onChange={setValue} extraUnits={extra} />
        <input type="text" aria-label="other" defaultValue="" />
      </div>
    );
  }

  it("closes the list after a click pick", async () => {
    render(<Controlled />);
    const unit = document.getElementById("u") as HTMLInputElement;
    await userEvent.click(unit);
    await userEvent.click(screen.getByRole("button", { name: "case" }));
    expect(unit.value).toBe("case");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes the list when focus moves on with Tab", async () => {
    render(<Controlled />);
    const unit = document.getElementById("u") as HTMLInputElement;
    await userEvent.type(unit, "case");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape and on Enter", async () => {
    render(<Controlled />);
    const unit = document.getElementById("u") as HTMLInputElement;
    await userEvent.type(unit, "ca");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.type(unit, "se{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows one suggestion for Case and case, keeping the tenant's own spelling", async () => {
    render(<Controlled extra={["Case", "Firkin"]} />);
    await userEvent.click(document.getElementById("u") as HTMLInputElement);
    expect(screen.getByRole("button", { name: "Case" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "case" })).toBeNull();
    expect(screen.getByRole("button", { name: "Firkin" })).toBeInTheDocument();
  });
});
