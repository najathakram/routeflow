import * as React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { FiltersDisclosure, activeFilterCount } from "./FiltersDisclosure";

describe("activeFilterCount", () => {
  it("counts only values that differ from their defaults", () => {
    expect(
      activeFilterCount(
        { search: "acme", dateFrom: "", dateTo: "2026-01-02", status: "ALL" },
        { search: "", dateFrom: "", dateTo: "", status: "ALL" },
      ),
    ).toBe(2);
  });

  it("is zero when nothing changed and treats a missing default as empty", () => {
    expect(activeFilterCount({ a: "", b: "x" }, { a: "" })).toBe(1);
    expect(activeFilterCount({ a: "" }, { a: "" })).toBe(0);
  });
});

describe("FiltersDisclosure", () => {
  function setup(count: number) {
    return render(
      <FiltersDisclosure count={count}>
        <input aria-label="Search" />
        <input aria-label="From" />
      </FiltersDisclosure>,
    );
  }

  it('reads "Filters (2)" and keeps the same controls in the panel', async () => {
    const user = userEvent.setup();
    setup(2);
    const button = screen.getByRole("button", { name: "Filters (2)" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button.className).toContain("md:hidden");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
  });

  it("closed below md, the panel is hidden but shown inline from md up", () => {
    setup(0);
    const panel = screen.getByLabelText("Search").parentElement as HTMLElement;
    expect(panel.className).toContain("hidden");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("takes no box from md up: root and panel are md:contents, so the controls are direct items of the page bar", () => {
    setup(0);
    const panel = screen.getByLabelText("Search").parentElement as HTMLElement;
    expect(panel.className.split(" ")).toContain("md:contents");
    expect(panel.className.split(" ")).not.toContain("md:block");
    expect((panel.parentElement as HTMLElement).className.split(" ")).toContain("md:contents");
  });

  it("the button controls the panel by id", () => {
    setup(1);
    const panel = screen.getByLabelText("Search").parentElement as HTMLElement;
    expect(panel.id).not.toBe("");
    expect(screen.getByRole("button", { name: "Filters (1)" })).toHaveAttribute(
      "aria-controls",
      panel.id,
    );
  });

  it("puts a toolbar next to the Filters button on the same row, outside the panel", () => {
    render(
      <FiltersDisclosure count={0} toolbar={<span>Sort here</span>}>
        <input aria-label="From" />
      </FiltersDisclosure>,
    );
    const button = screen.getByRole("button", { name: "Filters" });
    const tool = screen.getByText("Sort here");
    expect(tool.parentElement).toBe(button.parentElement);
    const panel = screen.getByLabelText("From").parentElement as HTMLElement;
    expect(panel).not.toContainElement(tool);
  });

  it("opening makes the panel visible", async () => {
    const user = userEvent.setup();
    setup(1);
    const panel = screen.getByLabelText("Search").parentElement as HTMLElement;
    await user.click(screen.getByRole("button", { name: "Filters (1)" }));
    expect(panel.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });
});
