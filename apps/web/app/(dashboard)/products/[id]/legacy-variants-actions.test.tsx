import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { LegacyVariantsActions, variantModalTitle } from "./LegacyVariantsActions";

function setup(over: { isOperator?: boolean; kind?: string } = {}) {
  const onAddVariant = jest.fn();
  render(
    <LegacyVariantsActions
      product={{ kind: over.kind ?? "SIMPLE", parentProductId: null }}
      isOperator={over.isOperator ?? true}
      onSplit={jest.fn()}
      onLinkExisting={jest.fn()}
      onAddVariant={onAddVariant}
    />,
  );
  return { onAddVariant };
}

describe("LegacyVariantsActions (VU-2)", () => {
  it("operator: 'Add variant' (sentence case) plus the family caption and link", () => {
    const { onAddVariant } = setup();
    expect(screen.queryByRole("button", { name: "Add Variant" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add variant" }));
    expect(onAddVariant).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Adding many at once\?/)).toBeInTheDocument();
    expect(screen.getByText(/with a grid\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a family" })).toHaveAttribute(
      "href",
      "/products?newFamily=1",
    );
    // every existing control is kept
    expect(screen.getByRole("button", { name: "Assign to variants" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link existing" })).toBeInTheDocument();
  });

  it("r3: the button row wraps and right-aligns inside the card on a phone", () => {
    setup();
    const row = screen.getByRole("button", { name: "Link existing" }).parentElement as HTMLElement;
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(row.className).toMatch(/\bjustify-end\b/);
    const outer = row.parentElement as HTMLElement;
    expect(outer.className).toMatch(/\bmax-w-full\b/);
    // order kept; 44 px targets below sm
    const names = screen.getAllByRole("button").map((b) => b.textContent?.trim());
    expect(names).toEqual(["Assign to variants", "Link existing", "Add variant"]);
    for (const b of screen.getAllByRole("button")) {
      expect(b.className).toMatch(/\bmin-h-11\b/);
      expect(b.className).toMatch(/\bsm:min-h-0\b/);
    }
  });

  it("other roles: no controls and no link", () => {
    setup({ isOperator: false });
    expect(screen.queryByRole("link", { name: "Create a family" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add variant" })).toBeNull();
  });

  it("a FAMILY product renders neither", () => {
    setup({ kind: "FAMILY" });
    expect(screen.queryByRole("link", { name: "Create a family" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add variant" })).toBeNull();
  });

  it("modal titles are sentence case", () => {
    expect(variantModalTitle(false)).toBe("Add variant");
    expect(variantModalTitle(true)).toBe("Edit variant");
  });
});
