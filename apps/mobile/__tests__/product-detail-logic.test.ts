/**
 * Buyer product detail (#2345) — pure logic. The money pin: a variant row's
 * price is the SAME number the variant's own catalog tile shows (and the cart
 * bills), never its raw buyerPrice.
 */
import type { PromotionRule } from "@routeflow/pricing";
import type { BuyerProductVariant } from "@routeflow/types";
import {
  galleryImages,
  identifierLine,
  productDetailState,
  variantPrice,
} from "../lib/product-detail-logic";
import { deriveTilePrice } from "../lib/catalog-tile-logic";
import type { CartItem } from "../store/cartStore";

const httpErr = (status: number) => ({ response: { status } });

describe("productDetailState", () => {
  const base = { isLoading: false, isError: false, error: null, hasData: true };

  it("loading wins while the query is in flight", () => {
    expect(productDetailState({ ...base, isLoading: true, hasData: false })).toBe("loading");
  });

  it.each([404, 403])("a %i is 'not-available' — the two are never told apart", (status) => {
    expect(productDetailState({ ...base, isError: true, error: httpErr(status) })).toBe(
      "not-available",
    );
  });

  it.each([
    ["a 500", httpErr(500)],
    ["a network error", new Error("Network Error")],
    ["no error object", null],
  ])("%s is a retryable 'error', not 'not-available'", (_l, error) => {
    expect(productDetailState({ ...base, isError: true, error })).toBe("error");
  });

  it("data present and no error → ready", () => {
    expect(productDetailState(base)).toBe("ready");
  });
});

describe("galleryImages", () => {
  it("uses every imageUrl when present", () => {
    expect(galleryImages({ imageUrls: ["a", "b"], thumbnailUrl: "t" })).toEqual(["a", "b"]);
  });
  it("falls back to the thumbnail, then to nothing", () => {
    expect(galleryImages({ imageUrls: [], thumbnailUrl: "t" })).toEqual(["t"]);
    expect(galleryImages({ imageUrls: null, thumbnailUrl: null })).toEqual([]);
  });
});

describe("identifierLine", () => {
  it("joins SKU and barcode like web", () => {
    expect(identifierLine({ sku: "S1", barcode: "0123" })).toBe("SKU: S1 · Barcode: 0123");
  });
  it("shows whichever one exists", () => {
    expect(identifierLine({ sku: "S1", barcode: null })).toBe("SKU: S1");
    expect(identifierLine({ sku: null, barcode: "0123" })).toBe("Barcode: 0123");
  });
  it("is null when neither exists", () => {
    expect(identifierLine({ sku: "", barcode: null })).toBeNull();
  });
});

describe("variantPrice — cent parity with the variant's own tile", () => {
  const variant = (o: Partial<BuyerProductVariant> = {}): BuyerProductVariant => ({
    id: "v1",
    name: "Cola 12-pack",
    sku: "COLA-12",
    buyerPrice: 120,
    unit: "case",
    category: "Drinks",
    unitsPerBox: 12,
    ...o,
  });

  const tileOf = (v: BuyerProductVariant, rules: PromotionRule[], item?: CartItem) =>
    deriveTilePrice(
      {
        id: v.id,
        buyerPrice: v.buyerPrice,
        category: v.category,
        unitsPerBox: v.unitsPerBox,
      },
      rules,
      item,
    );

  it("no promo → the variant's own price, no strikethrough", () => {
    const p = variantPrice(variant(), [], undefined);
    expect(p.unitPrice).toBe(120);
    expect(p.originalPrice).toBeNull();
  });

  it("a PERCENT promo prices the row net with a struck original (never the raw buyerPrice)", () => {
    const rules: PromotionRule[] = [{ id: "p1", type: "PERCENT", value: 10, scope: "ALL" }];
    const p = variantPrice(variant(), rules, undefined);
    expect(p.unitPrice).toBe(108);
    expect(p.originalPrice).toBe(120);
    expect(p).toEqual(tileOf(variant(), rules));
  });

  it("a CATEGORY promo matches on the variant's own category", () => {
    const rules: PromotionRule[] = [
      { id: "c1", type: "PERCENT", value: 25, scope: "CATEGORY", category: "Drinks" },
    ];
    expect(variantPrice(variant(), rules, undefined).unitPrice).toBe(90);
    // A null-category variant is out of a category-scoped promo, same as its tile.
    const bare = variant({ category: null });
    expect(variantPrice(bare, rules, undefined).unitPrice).toBe(120);
    expect(variantPrice(bare, rules, undefined)).toEqual(tileOf(bare, rules));
  });

  it("uses the cart line's quantity when the variant is already in the cart", () => {
    const rules: PromotionRule[] = [
      { id: "q1", type: "QTY_BREAK", value: 20, minQty: 36, scope: "ALL" },
    ];
    const inCart: CartItem = {
      productId: "v1",
      name: "Cola 12-pack",
      unitPrice: 120,
      qty: 36,
      category: "Drinks",
      unitsPerBox: 12,
      boxes: 3,
      pieces: 0,
    };
    expect(variantPrice(variant(), rules, undefined).unitPrice).toBe(120); // 1 box < 36 pcs
    expect(variantPrice(variant(), rules, inCart)).toEqual(tileOf(variant(), rules, inCart));
    expect(variantPrice(variant(), rules, inCart).unitPrice).toBe(96);
  });
});
