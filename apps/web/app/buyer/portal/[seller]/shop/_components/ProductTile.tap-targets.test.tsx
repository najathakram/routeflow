import * as React from "react";
import { render, screen } from "@testing-library/react";
import type { BuyerProduct } from "@routeflow/types";
import { ProductTile } from "./ProductTile";

/**
 * Out-of-stock polish: at 390px wide the favourite heart (36px) and "Add" (~32px) were under the
 * 44px tap-target floor, and "Notify me" wrapped at 1440. Class-level checks (RTL); the rendered
 * pixel sizes are proven by Playwright.
 */
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const product = (over: Partial<BuyerProduct> = {}): BuyerProduct => ({
  id: "p1",
  name: "Widget",
  description: null,
  sku: "W-1",
  barcode: null,
  unit: "ea",
  category: "Snacks",
  buyerPrice: 5,
  unitsPerBox: null,
  thumbnailUrl: null,
  imageKeys: [],
  isFeatured: false,
  isNew: false,
  isDeal: false,
  imageUrls: [],
  inStock: true,
  stockStatus: "IN_STOCK",
  stockLeft: null,
  ...over,
});

function setup(p: BuyerProduct, size?: "sm" | "md" | "lg") {
  render(
    <ProductTile
      product={p}
      sellerSlug="acme"
      cartItem={undefined}
      promoRules={[]}
      onAdd={jest.fn()}
      onUpdateQty={jest.fn()}
      onToggleFavorite={jest.fn()}
      onToggleStockAlert={jest.fn()}
      isFavorite={false}
      size={size}
    />,
  );
}

describe("ProductTile tap targets and Notify me", () => {
  it.each([undefined, "sm" as const])("the heart has a 44px hit area (density %s)", (size) => {
    setup(product(), size);
    const heart = screen.getByTitle("Add to favorites");
    expect(heart.className).toMatch(/\bmin-h-11\b/);
    expect(heart.className).toMatch(/\bmin-w-11\b/);
  });

  it.each([undefined, "sm" as const])("Add has a 44px hit height (density %s)", (size) => {
    setup(product(), size);
    expect(screen.getByRole("button", { name: /^add$/i }).className).toMatch(/\bmin-h-11\b/);
  });

  it("Notify me never wraps and has a 44px hit height", () => {
    setup(product({ stockStatus: "OUT_OF_STOCK", inStock: false }));
    const btn = screen.getByRole("button", { name: /notify me/i });
    expect(btn.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(btn.className).toMatch(/\bmin-h-11\b/);
    expect(btn.className).toMatch(/\bshrink-0\b/);
  });
});
