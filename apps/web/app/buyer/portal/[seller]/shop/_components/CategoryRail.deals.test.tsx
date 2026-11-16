import { render, screen } from "@testing-library/react";
import { CategoryRail } from "./CategoryRail";
import type { BuyerCatalogCounts } from "@/lib/api/buyer";

function counts(total: number, deals: number): BuyerCatalogCounts {
  return {
    total,
    categories: [],
    lockedCategories: [],
    collections: { usuals: 0, favorites: 0, new: 0, deals },
  } as unknown as BuyerCatalogCounts;
}

describe("CategoryRail deals row (UX guide B18)", () => {
  it("shows no Deals row when every product is a deal", () => {
    render(<CategoryRail counts={counts(5, 5)} selection={{ kind: "all" }} onSelect={() => {}} />);
    expect(screen.queryByText("Deals")).toBeNull();
  });
  it("shows the Deals row when some products are deals", () => {
    render(<CategoryRail counts={counts(5, 2)} selection={{ kind: "all" }} onSelect={() => {}} />);
    expect(screen.getByText("Deals")).toBeTruthy();
  });
});
