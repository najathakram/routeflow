import { roundMoney } from "@routeflow/pricing";
import { assertCustomPricesAllowed } from "./staff-override";

type Entry = {
  id?: string | null;
  productId?: string | null;
  name?: string | null;
  qty?: number | null;
  unitPrice?: number | string | null;
};
type HeldLine = {
  id: string;
  productId?: string | null;
  name?: string | null;
  unitPrice?: unknown;
};

/**
 * SA-1034 rule 4: the entries of a STAFF full-replace payload that author a custom (unlisted) line, for
 * `assertCustomPricesAllowed`. Only an entry the replace loop would write counts (named, qty > 0, priced). It is
 * authoring when no held custom line has its id (no id: the same name and cent price), or when the held line it names
 * is re-sent at a different price. A resubmitted, unchanged line is not authoring, so an operator without price
 * rights can still save an order that already holds a custom item.
 */
export function authoredCustomEntries<T extends Entry>(
  items: readonly T[],
  held: readonly HeldLine[],
): T[] {
  const custom = held.filter((h) => !h.productId);
  const cents = (v: unknown) => roundMoney(Number(v));
  return items.filter((item) => {
    const name = (item.name ?? "").trim();
    if (item.productId || !name || (item.qty ?? 0) <= 0 || item.unitPrice == null) return false;
    const typed = cents(item.unitPrice);
    const same = item.id
      ? custom.find((h) => h.id === item.id)
      : custom.find((h) => (h.name ?? "").trim() === name && cents(h.unitPrice) === typed);
    return !same || cents(same.unitPrice) !== typed;
  });
}

/** The edit-site check (verbatim move from updateOrderItems): the held lines' names come from the order's own rows. */
export function assertEditAuthoredCustomPrices(
  items: readonly Entry[],
  heldItems: readonly HeldLine[],
  lineItems: readonly { id: string; name?: string | null }[],
  priceEditAllowed: boolean,
): void {
  const held = heldItems.map((h) => ({ ...h, name: lineItems.find((l) => l.id === h.id)?.name }));
  assertCustomPricesAllowed(authoredCustomEntries(items, held), priceEditAllowed);
}
