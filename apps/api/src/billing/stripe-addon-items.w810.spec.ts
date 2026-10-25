/**
 * W-810: a redelivered checkout completion re-reads the subscription. An in-app add-on item (an owned
 * `rf_addon_<sku>` product that carries `addonSku`) must be recognised as that SKU's item, not mistaken for the
 * base plan item, and the base item on an owned or Checkout-born product must never match.
 */
import { checkoutAddonItems } from "./stripe-addon-items";

const addonItem = {
  id: "si_addon",
  quantity: 1,
  price: {
    unit_amount: 4900,
    product: { id: "rf_addon_forecasting", metadata: { addonSku: "forecasting" } },
  },
};
const baseOwned = {
  id: "si_base",
  quantity: 1,
  price: { unit_amount: 24900, product: { id: "rf_plan_growth", metadata: { planKey: "GROWTH" } } },
};
const baseCheckoutBorn = {
  id: "si_base2",
  quantity: 1,
  price: { unit_amount: 24900, product: "prod_checkout_inline" },
};

describe("checkoutAddonItems with W-810 owned products", () => {
  it("recognises an in-app add-on item by its owned product's addonSku", () => {
    const found = checkoutAddonItems({ items: { data: [baseOwned, addonItem] } });
    expect(found).toEqual([
      expect.objectContaining({ itemId: "si_addon", sku: "forecasting", unitAmountCents: 4900 }),
    ]);
  });

  it("is idempotent across a redelivery: the same subscription yields the same items", () => {
    const sub = { items: { data: [baseCheckoutBorn, addonItem] } };
    expect(checkoutAddonItems(sub)).toEqual(checkoutAddonItems(sub));
    expect(checkoutAddonItems(sub).map((i) => i.itemId)).toEqual(["si_addon"]);
  });

  it("never takes a base plan item (owned or Checkout-born) for an add-on", () => {
    expect(checkoutAddonItems({ items: { data: [baseOwned, baseCheckoutBorn] } })).toEqual([]);
  });
});
