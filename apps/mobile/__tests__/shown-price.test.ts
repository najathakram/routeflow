import { customerLinePrice, customerPricingGate, customerTierFor } from "@routeflow/pricing";
import { shownPrice } from "../lib/price-layer-gate";

/**
 * SA-882 MUST (W-741): a product NOT yet added shows its customer's price only once the gate is open. A tier-3 customer whose
 * customer read FAILED (no data) resolves to tier 1, so the row head showed LIST ($10.00) as if it were their price. While
 * the gate blocks the pick, the head shows "…" (null); after a successful Retry it shows the tier-3 price ($8.00).
 */
const off = { enabled: false, ready: true, failed: false, lineReady: () => true };
const PRODUCT = { id: "p1", pricePerUnit: "10", priceTier3: "8" };
const head = (customer: { data?: { pricingTier: number }; isError?: boolean }) => {
  const gate = customerPricingGate({
    customerQuery: customer,
    customerPricesQuery: { data: [] },
    priceLayer: off,
  });
  const clp = customerLinePrice({
    product: PRODUCT,
    tier: customerTierFor(undefined, customer.data?.pricingTier),
  });
  return { unguarded: clp.price, shown: shownPrice(gate, "c1", off, PRODUCT.id, clp) };
};

describe("SA-882: a not-yet-added product's price waits for the gate", () => {
  it("a FAILED customer read: the tier falls to 1 (LIST $10), so the head shows … instead", () => {
    const failed = head({ isError: true, data: undefined });
    expect(failed.unguarded).toBe(10); // what the head showed before this fix
    expect(failed.shown).toBeNull();
  });

  it("after a successful Retry the head shows the tier-3 price", () => {
    expect(head({ data: { pricingTier: 3 } }).shown).toBe(8);
  });

  it("no customer chosen: the catalogue price shows as before", () => {
    const gate = customerPricingGate({
      customerQuery: { isPending: true },
      customerPricesQuery: { isPending: true },
      priceLayer: off,
    });
    const clp = customerLinePrice({ product: PRODUCT, tier: 1 });
    expect(shownPrice(gate, null, off, PRODUCT.id, clp)).toBe(10);
  });

  it("gate open but the layer cannot vouch for this product: … (confirmedPrice)", () => {
    const gate = customerPricingGate({
      customerQuery: { data: {} },
      customerPricesQuery: { data: [] },
      priceLayer: off,
    });
    const partial = { ...off, enabled: true, lineReady: (id?: string | null) => id !== "p1" };
    expect(shownPrice(gate, "c1", partial, "p1", { price: 8 })).toBeNull();
  });
});

describe("SA-882: every not-yet-added price surface goes through shownPrice", () => {
  const { readFileSync } = jest.requireActual<typeof import("fs")>("fs");
  const { join } = jest.requireActual<typeof import("path")>("path");
  const src = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  it.each(["components/NewOrderScreen.tsx", "app/(operator)/(tabs)/invoices/new.tsx"])(
    "%s: a catalogue or search row with no line shows pick.shown(...)",
    (rel) => {
      expect(src(rel)).toMatch(
        /const price = line\s*\?[^:]+:\s*pick\.shown\(p\.id, packPriceFor\(p\)\);/,
      );
      expect(src(rel)).toMatch(/pick\.gate\.blockPick,/); // the row memo re-renders when the gate opens
    },
  );
  it("customers/[id]/catalog: the row price waits on the shared gate", () => {
    expect(src("app/(operator)/customers/[id]/catalog.tsx")).toMatch(
      /shownPrice\(pricingGate, customerId, priceLayer, cp\.productId, clp\)/,
    );
  });
  it("ProductRow renders … for a null price, never $NaN", () => {
    expect(src("components/ProductRow.tsx")).toMatch(
      /price == null \? "\\u2026" : `\$\$\{price\.toFixed\(2\)\}`/,
    );
  });
});
