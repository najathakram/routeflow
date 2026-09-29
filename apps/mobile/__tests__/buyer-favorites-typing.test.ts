import { readFileSync } from "fs";
import { join } from "path";

// #2703 (SA-562): GET /buyer/favorites returns BuyerFavoriteProduct — its `id` is the FAVORITE
// row's id and the product is `productId`. The screen used idOf/priceOf workarounds for a
// mis-typed BuyerProduct[]; now the type is right, un-favorite and add-to-cart must key on
// productId and price at the server's buyerPrice. RN screens aren't renderable in this lane, so
// the wiring is source-pinned.
describe("buyer favorites (#2703): typed as BuyerFavoriteProduct, keyed on productId", () => {
  const screen = readFileSync(join(__dirname, "..", "app/(customer)/favorites.tsx"), "utf8");
  const api = readFileSync(join(__dirname, "..", "lib/api/buyer.ts"), "utf8");

  it("the favorites query is typed BuyerFavoriteProduct[], not BuyerProduct[]", () => {
    const at = api.indexOf("export function useBuyerFavorites()");
    expect(at).toBeGreaterThan(-1);
    expect(api.slice(at, at + 200)).toMatch(/useQuery<BuyerFavoriteProduct\[\]>/);
  });

  it("the idOf / priceOf workarounds and the dead basePrice/price fallbacks are gone", () => {
    expect(screen).not.toMatch(/\bidOf\(|\bpriceOf\(/);
    expect(screen).not.toMatch(/basePrice|\bp\.price\b/); // the row's dead fallback (styles.price is a style)
  });

  it("un-favorite and add-to-cart use productId and the server's buyerPrice", () => {
    expect(screen).toMatch(/const id = p\.productId;/);
    expect(screen).toMatch(/const price = p\.buyerPrice;/);
    expect(screen).toMatch(/toggleFavorite\.mutate\(\{ productId: id, isFavorite: true \}\)/);
    expect(screen).toMatch(/productId: id,\s*name: p\.name,\s*unitPrice: price,/);
  });
});

// #2703 lead fold: GET /buyer/orders returns LIST rows (OrdersService.findAll), so the list hook
// is typed BuyerOrderListItem[] — never the detail's BuyerOrder.
describe("buyer orders list (#2703): typed as the list row", () => {
  const api = readFileSync(join(__dirname, "..", "lib/api/buyer.ts"), "utf8");
  it("useBuyerOrders is typed BuyerOrderListItem[]", () => {
    const at = api.indexOf("export function useBuyerOrders(");
    expect(at).toBeGreaterThan(-1);
    expect(api.slice(at, at + 400)).toMatch(/useQuery<\{ data: BuyerOrderListItem\[\];/);
  });
});
