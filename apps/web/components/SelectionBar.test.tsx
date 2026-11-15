import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { SelectionBar } from "./SelectionBar";

const PAGE_BAR = "flex items-center justify-between rounded-lg border px-4 py-3";

describe("SelectionBar", () => {
  it("keeps the page's own bar classes and adds only max-md: classes", () => {
    render(
      <SelectionBar className={PAGE_BAR}>
        <span>2 selected</span>
      </SelectionBar>,
    );
    const bar = screen.getByText("2 selected").closest("[data-selection-bar]") as HTMLElement;
    const classes = bar.className.split(" ");
    for (const c of PAGE_BAR.split(" ")) expect(classes).toContain(c);
    const added = classes.filter((c) => !PAGE_BAR.split(" ").includes(c));
    expect(added.length).toBeGreaterThan(0);
    for (const c of added) expect(c.startsWith("max-md:")).toBe(true);
  });

  it("is fixed to the bottom of the screen below md, inset, above the safe area, over the page", () => {
    render(
      <SelectionBar className={PAGE_BAR}>
        <span>2 selected</span>
      </SelectionBar>,
    );
    const bar = screen.getByText("2 selected").closest("[data-selection-bar]") as HTMLElement;
    const classes = bar.className.split(" ");
    expect(classes).toContain("max-md:fixed");
    expect(classes).toContain("max-md:inset-x-3");
    expect(bar.className).toContain("env(safe-area-inset-bottom)");
    expect(classes.some((c) => /^max-md:z-/.test(c))).toBe(true);
    expect(classes).toContain("max-md:shadow-card");
  });

  it("holds a select-all checkbox below md only, with its visible text as the name", async () => {
    const onChange = jest.fn();
    render(
      <SelectionBar className={PAGE_BAR} selectAll={{ checked: false, onChange }}>
        <span>2 selected</span>
      </SelectionBar>,
    );
    const box = screen.getByRole("checkbox", { name: "Select all on this page" });
    const label = box.closest("label") as HTMLElement;
    expect(label.className.split(" ")).toContain("md:hidden");
    expect(label.className).toContain("min-h-[44px]");
    expect(label.textContent).toBe("Select all on this page");
    await userEvent.setup().click(box);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("can name the checkbox differently and show it indeterminate", () => {
    render(
      <SelectionBar
        className={PAGE_BAR}
        selectAll={{
          checked: false,
          indeterminate: true,
          onChange: jest.fn(),
          label: "Select all customers on this page",
        }}
      >
        <span>2 selected</span>
      </SelectionBar>,
    );
    const box = screen.getByRole("checkbox", {
      name: "Select all customers on this page",
    }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
  });

  it("renders no checkbox without selectAll", () => {
    render(
      <SelectionBar className={PAGE_BAR}>
        <span>2 selected</span>
      </SelectionBar>,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
