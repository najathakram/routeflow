import { toCents } from "@routeflow/pricing";

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
      unit_amount: toCents(Number(a.monthlyPrice)),
      recurring: { interval: "month" as const },
      product_data: {
        name: `RouteFlow add-on — ${a.name}`,
        metadata: { [CHECKOUT_ADDON_SKU_KEY]: a.sku },
      },
    },
    quantity: a.quantity,
  };
}

/**
 * ONE rule for "which of a subscription's items are add-ons" (L-167): the items a tenant add-on row owns
 * (`stripeItemId`) PLUS the checkout-made add-on lines the completion has not adopted onto a row yet. Every
 * reader that must find the BASE item (the scheduled price push, the pre-flip check, the post-flip verify)
 * calls this - a second copy that forgets the checkout lines picks an add-on as the base.
 */
export async function stripeAddonItemIds(
  prisma: {
    tenantAddon: {
      findMany(args: any): Promise<unknown>;
    };
  },
  tenantId: string,
  stripeSub: unknown,
): Promise<Set<string>> {
  const owned = (await prisma.tenantAddon.findMany({
    where: { tenantId, stripeItemId: { not: null } },
    select: { stripeItemId: true },
  })) as { stripeItemId: string | null }[];
  return new Set<string>([
    ...owned.map((r) => r.stripeItemId as string),
    ...checkoutAddonItems(stripeSub).map((i) => i.itemId),
  ]);
}

/**
 * ONE recognizer for "an add-on item RouteFlow's in-app path made for this tenant and SKU" (metadata
 * `{tenantId, sku}`): shared by orphan adoption and the stranded-item sweep (G1a). The plan item and a checkout
 * line (tagged `addonSku` on its product, never `metadata.sku`) never match.
 */
export function isOwnedAddonItem(item: unknown, tenantId: string, sku: string): boolean {
  const m = (item as { metadata?: Record<string, unknown> | null } | null | undefined)?.metadata;
  return m?.tenantId === tenantId && m?.sku === sku;
}

/** A subscription item Stripe made from a checkout add-on line. */
export interface CheckoutAddonItem {
  itemId: string;
  sku: string;
  /** The item's quantity; 0 when Stripe's object does not carry a readable integer (see `quantityReadable`). */
  quantity: number;
  /** False when the object carries no integer quantity: unreadable (transient), as opposed to a real 0. */
  quantityReadable: boolean;
  /** The item's actual unit price in cents; null when Stripe's object does not carry a readable one. */
  unitAmountCents: number | null;
}

/** The slice of a Stripe subscription item (API 2026-08-26.dahlia) the add-on adoption reads. */
interface StripeItemLike {
  id?: unknown;
  quantity?: unknown;
  price?: {
    metadata?: Record<string, string> | null;
    /** An id until expanded; the object (with its metadata) after `items.data.price.product`. */
    product?: string | { metadata?: Record<string, string> | null } | null;
    unit_amount?: number | null;
    unit_amount_decimal?: string | null;
  } | null;
}

/** The `addonSku` tag on an item: its expanded product's metadata, else its price's. */
function addonSkuOf(item: StripeItemLike): string | null {
  const product = item.price?.product;
  const fromProduct =
    product && typeof product === "object" ? product.metadata?.[CHECKOUT_ADDON_SKU_KEY] : undefined;
  const sku = fromProduct ?? item.price?.metadata?.[CHECKOUT_ADDON_SKU_KEY];
  return typeof sku === "string" && sku ? sku : null;
}

/** The item's unit price in cents: `unit_amount`, else the rounded decimal; null when neither reads. */
function unitAmountCentsOf(item: StripeItemLike): number | null {
  const price = item.price;
  if (typeof price?.unit_amount === "number") return price.unit_amount;
  const decimal = Number(price?.unit_amount_decimal);
  return price?.unit_amount_decimal != null && Number.isFinite(decimal)
    ? Math.round(decimal)
    : null;
}

/**
 * The add-on items on a retrieved subscription: every item whose price or (expanded) product
 * metadata names an `addonSku`. The base plan item, and any item the in-app enable path made
 * (its tag is `metadata.sku`, not `addonSku`), never matches.
 */
export function checkoutAddonItems(stripeSub: unknown): CheckoutAddonItem[] {
  const data = (stripeSub as { items?: { data?: unknown } } | null | undefined)?.items?.data;
  const items: StripeItemLike[] = Array.isArray(data) ? (data as StripeItemLike[]) : [];
  const out: CheckoutAddonItem[] = [];
  for (const i of items) {
    const sku = addonSkuOf(i);
    if (!sku || typeof i.id !== "string") continue;
    out.push({
      itemId: i.id,
      sku,
      quantity: Number.isInteger(i.quantity) ? (i.quantity as number) : 0,
      quantityReadable: Number.isInteger(i.quantity),
      unitAmountCents: unitAmountCentsOf(i),
    });
  }
  return out;
}

/**
 * The add-on SKUs a checkout LISTED (`addonSkus`, comma-joined, on the session and on the subscription it made),
 * across any number of metadata objects: trimmed, de-duplicated, sorted. A completion uses it to know which SKUs
 * MUST have a recognised item — a listed SKU with none is an anomaly, not a row to bill again.
 */
export function listedCheckoutAddonSkus(...metadata: unknown[]): string[] {
  const out = new Set<string>();
  for (const m of metadata) {
    const raw = (m as Record<string, unknown> | null | undefined)?.[CHECKOUT_ADDON_SKUS_KEY];
    if (typeof raw !== "string") continue;
    for (const sku of raw.split(",")) if (sku.trim()) out.add(sku.trim());
  }
  return [...out].sort();
}
