import { roundMoney } from "@routeflow/pricing";

/**
 * SA-690 option A: a trial's add-ons are billed at the CARD CHECKOUT. Each unbilled self-serve
 * add-on becomes one extra line on the Stripe Checkout Session, tagged so the completion webhook can
 * find the subscription item Stripe made from it and adopt it onto the tenant's add-on row.
 *
 * The shapes here are Stripe API 2026-08-26.dahlia (stripe-period.ts pins it): an inline
 * `price_data` line cannot carry price metadata, so the tag lives on its `product_data.metadata`,
 * which the completion reads back with `items.data.price.product` expanded.
 */

/** Product metadata key stamped on each checkout add-on line: the add-on's SKU code. */
export const CHECKOUT_ADDON_SKU_KEY = "addonSku";

/** Session + subscription metadata key: the comma-joined SKU codes the checkout bills. */
export const CHECKOUT_ADDON_SKUS_KEY = "addonSkus";

/** The `expand` list that makes a retrieved subscription carry each item's product metadata. */
export const CHECKOUT_ADDON_EXPAND = ["items.data.price.product"];

/** A dollar price as integer cents — rounded to cents first, so float noise never moves a cent. */
export function toCents(dollars: unknown): number {
  return Math.round(roundMoney(Number(dollars)) * 100);
}

/** Integer cents as a dollar figure, rounded like every other money write. */
export function fromCents(cents: number): number {
  return roundMoney(cents / 100);
}

/** One add-on's checkout line: a MONTHLY inline price at the catalog amount, tagged with its SKU. */
export function checkoutAddonLineItem(a: {
  sku: string;
  name: string;
  monthlyPrice: unknown;
  quantity: number;
}) {
  return {
    price_data: {
      currency: "usd",
      unit_amount: toCents(a.monthlyPrice),
      recurring: { interval: "month" as const },
      product_data: {
        name: `RouteFlow add-on — ${a.name}`,
        metadata: { [CHECKOUT_ADDON_SKU_KEY]: a.sku },
      },
    },
    quantity: a.quantity,
  };
}

/** A subscription item Stripe made from a checkout add-on line. */
export interface CheckoutAddonItem {
  itemId: string;
  sku: string;
  quantity: number;
  /** The item's actual unit price in cents; null when Stripe's object does not carry a readable one. */
  unitAmountCents: number | null;
}

/**
 * The add-on items on a retrieved subscription: every item whose price or (expanded) product
 * metadata names an `addonSku`. The base plan item, and any item the in-app enable path made
 * (its tag is `metadata.sku`, not `addonSku`), never matches.
 */
export function checkoutAddonItems(stripeSub: any): CheckoutAddonItem[] {
  const items: any[] = Array.isArray(stripeSub?.items?.data) ? stripeSub.items.data : [];
  const out: CheckoutAddonItem[] = [];
  for (const i of items) {
    const product = i?.price?.product;
    const sku =
      product?.metadata?.[CHECKOUT_ADDON_SKU_KEY] ?? i?.price?.metadata?.[CHECKOUT_ADDON_SKU_KEY];
    if (typeof sku !== "string" || !sku || typeof i?.id !== "string") continue;
    const decimal = Number(i?.price?.unit_amount_decimal);
    const unit =
      typeof i?.price?.unit_amount === "number"
        ? i.price.unit_amount
        : i?.price?.unit_amount_decimal != null && Number.isFinite(decimal)
          ? Math.round(decimal)
          : null;
    out.push({
      itemId: i.id,
      sku,
      quantity: Number.isInteger(i.quantity) ? i.quantity : 0,
      unitAmountCents: unit,
    });
  }
  return out;
}
