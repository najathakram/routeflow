import * as React from "react";
import { render, screen } from "@testing-library/react";
import { ToastProvider } from "@routeflow/ui/web";
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

  it("the heart has an accessible name that follows its state, and says whether it is on", () => {
    const { unmount } = render(
      <ProductTile
        product={product()}
        sellerSlug="acme"
        cartItem={undefined}
        promoRules={[]}
        onAdd={jest.fn()}
        onUpdateQty={jest.fn()}
        onToggleFavorite={jest.fn()}
        onToggleStockAlert={jest.fn()}
        isFavorite={false}
      />,
    );
    const off = screen.getByRole("button", { name: "Add to favorites" });
    expect(off).toHaveAttribute("aria-pressed", "false");
    unmount();
    render(
      <ProductTile
        product={product()}
        sellerSlug="acme"
        cartItem={undefined}
        promoRules={[]}
        onAdd={jest.fn()}
        onUpdateQty={jest.fn()}
        onToggleFavorite={jest.fn()}
        onToggleStockAlert={jest.fn()}
        isFavorite
      />,
    );
    const on = screen.getByRole("button", { name: "Remove from favorites" });
    expect(on).toHaveAttribute("aria-pressed", "true");
  });

  it.each([undefined, "sm" as const])(
    "with the item in the cart the stepper gets its OWN full-width row at EVERY width (density %s)",
    (size) => {
      render(
        <ToastProvider>
          <ProductTile
            product={product()}
            sellerSlug="acme"
            cartItem={{ productId: "p1", qty: 3 } as never}
            promoRules={[]}
            onAdd={jest.fn()}
            onUpdateQty={jest.fn()}
            onToggleFavorite={jest.fn()}
            onToggleStockAlert={jest.fn()}
            isFavorite={false}
            size={size}
          />
        </ToastProvider>,
      );
      const plus = screen.getByRole("button", { name: "Increase Widget" });
      // Row 531 R3: at 1440 the 5-column tile left the stepper 102px (it needs 44 + 36 + 44 = 124), so its "+" was
      // clipped. The stepper's own root is a full-width row at EVERY width, never an inline box beside the price.
      const stepperRoot = plus.closest("[data-qty-stepper]") as HTMLElement;
      expect(stepperRoot).not.toBeNull();
      expect(stepperRoot.className).toMatch(/\bw-full\b/);
      expect(stepperRoot.className).not.toMatch(/\bsm:w-auto\b/);
      // the price row wraps at every width, so the stepper drops under the price instead of overshooting the tile
      expect(stepperRoot.parentElement!.className).toMatch(/\bflex-wrap\b/);
      expect(stepperRoot.parentElement!.className).not.toMatch(/\bsm:flex-nowrap\b/);
      // the grid's middle track (minmax(36px,1fr)) lets the field fill the row
      expect(stepperRoot.className).toContain("grid-cols-[44px_minmax(36px,1fr)_44px]");
      expect(screen.getByRole("textbox", { name: "Quantity" }).className).toMatch(/\bw-full\b/);
    },
  );

  it("a tile with a boxed line in the cart: the stepper, caption and toggle all sit below the price row", () => {
    render(
      <ToastProvider>
        <ProductTile
          product={product({ unitsPerBox: 12 })}
          sellerSlug="acme"
          cartItem={{ productId: "p1", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 } as never}
          promoRules={[]}
          onAdd={jest.fn()}
          onUpdateQty={jest.fn()}
          onSetUnit={jest.fn()}
          onToggleFavorite={jest.fn()}
          onToggleStockAlert={jest.fn()}
          isFavorite={false}
        />
      </ToastProvider>,
    );
    const unit = screen.getByTestId("cart-line-unit");
    const stepperRoot = screen
      .getByRole("button", { name: "Increase Widget" })
      .closest("[data-qty-stepper]") as HTMLElement;
    // the unit control is a sibling AFTER the price row, not inside it, so the row can never squeeze the stepper
    expect(stepperRoot.parentElement!.contains(unit)).toBe(false);
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (24 ea)");
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

  it("lets the price block shrink so long prices do not overflow narrow tiles", () => {
    setup(product({ buyerPrice: 1234567.89 }));
    const price = screen.getByText(/1,234,567\.89/);
    const block = price.closest("p")!.parentElement!.parentElement!;
    expect(block.className).toMatch(/(^|\s)min-w-0(\s|$)/);
  });
});
