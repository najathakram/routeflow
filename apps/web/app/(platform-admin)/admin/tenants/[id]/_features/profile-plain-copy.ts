/**
 * Plain-English names for the business profiles, keyed by the profile key. The server's label and description
 * (`apps/api/src/billing/business-profiles.ts`) are NOT edited: this file maps the key to the words a super admin
 * actually uses, falls back to the server's own text for a key this build does not know, and keeps the server label as
 * a muted secondary line so the two vocabularies can be matched.
 */

interface PlainProfile {
  name: string;
  line: string;
  /** Shown only while the choice is selected (SA-2): what the business will see. */
  bullets: [string, string, string];
}

const PLAIN_PROFILES: Record<string, PlainProfile> = {
  delivery_distributor: {
    name: "Delivery",
    line: "Delivers on its own trucks, with routes, ad hoc delivery and at-door payments.",
    bullets: [
      "Routes, ad hoc delivery and at-door payments in the menu",
      "Orders go out on the business's own trucks",
      "Counter sales are left as they are",
    ],
  },
  shipping_wholesaler: {
    name: "Shipping only",
    line: "Ships orders by carrier. No counter sales, no delivery.",
    bullets: [
      "Orders ship by carrier",
      "No counter sales",
      "No routes, delivery or driver payments",
    ],
  },
  in_store_retailer: {
    name: "POS only: counter sales",
    line: "Sells over the counter. Customers pick up in store. No delivery or shipping.",
    bullets: [
      "Counter in the menu",
      "Orders are in-store pickup only",
      "No routes, delivery or driver payments",
    ],
  },
  in_store_shipping_retailer: {
    name: "POS + shipping",
    line: "Sells over the counter and ships by carrier.",
    bullets: [
      "Counter in the menu",
      "Orders are in-store pickup or carrier shipping",
      "No routes, delivery or driver payments",
    ],
  },
  delivery_pos: {
    name: "Delivery + POS",
    line: "Delivers on its own trucks and also sells over the counter.",
    bullets: [
      "Routes, ad hoc delivery and at-door payments in the menu",
      "Orders go out on the business's own trucks",
      "Counter in the menu, optional beside delivery",
    ],
  },
};

export interface ProfilePlainCopy {
  /** The choice's name. */
  name: string;
  /** One line: what the business does / will see. */
  line: string;
  /** The server's own label, shown muted; `null` when the name already IS the server label (unknown key). */
  secondary: string | null;
}

export function profilePlainCopy(
  key: string,
  serverLabel: string,
  serverDescription: string,
): ProfilePlainCopy {
  const plain = Object.prototype.hasOwnProperty.call(PLAIN_PROFILES, key)
    ? PLAIN_PROFILES[key]
    : undefined;
  if (!plain) return { name: serverLabel, line: serverDescription, secondary: null };
  return { name: plain.name, line: plain.line, secondary: serverLabel };
}

/** The three "what this business will see" bullets for a profile key; `[]` for a key this build does not know. */
export function profileBullets(key: string): string[] {
  return Object.prototype.hasOwnProperty.call(PLAIN_PROFILES, key)
    ? [...PLAIN_PROFILES[key]!.bullets]
    : [];
}
