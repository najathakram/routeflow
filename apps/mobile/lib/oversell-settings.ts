import type { InventoryBuyerOversellMode } from "@routeflow/types";

/**
 * Settings → Ordering (mobile mirror of web's "Out-of-stock ordering" card). Pure rules, kept out
 * of the screen so they are tested like the rest of mobile's logic:
 *  - only the exact mode "backorder" is ON (the server reads it the same way and fails closed);
 *  - the switch only exists once the setting has loaded (never a guessed value);
 *  - a TENANT_ADMIN edits, anyone else reads;
 *  - toasts are fixed copy (never the server's text).
 */
export const OVERSELL_COPY = {
  section: "Out-of-stock ordering",
  label: "Let customers order items that are out of stock",
  hint:
    "When on, a customer's order can take an item's stock below zero and the order is a " +
    "backorder. Staff can always order items that are out of stock.",
  readOnly: "Only an admin can change this setting.",
  loadFailed: "Couldn't load the out-of-stock ordering setting.",
  saveFailed: "Couldn't save the out-of-stock ordering setting",
  savedOn: "Customers can now order items that are out of stock",
  savedOff: "Customers can no longer order items that are out of stock",
} as const;

/** OOS PR2: what customers see about backordered items. Only the exact value "hide" hides. */
export const VISIBILITY_COPY = {
  title: "What customers see about backordered items",
  show: 'Show it: the item says "Ships when restocked" and the order is tagged',
  hide: "Hide it: the item looks in stock and customers see nothing about backorders",
  needsSwitch: "This applies when out-of-stock ordering is on for a customer.",
  savedShow: "Customers will see that backordered items ship when restocked",
  savedHide: "Customers will no longer see anything about backorders",
  saveFailed: "Couldn't save what customers see about backordered items",
} as const;

export function visibilityMode(raw: unknown): "show" | "hide" {
  return raw === "hide" ? "hide" : "show";
}

/** May the Show / Hide choice be changed right now? Admin only, and only while backorders are on. */
export function canEditVisibility(role: string | null | undefined, oversellOn: boolean): boolean {
  return canEditOversell(role) && oversellOn;
}

export function oversellIsOn(mode: unknown): boolean {
  return mode === "backorder";
}

export function nextOversellMode(currentlyOn: boolean): InventoryBuyerOversellMode {
  return currentlyOn ? "off" : "backorder";
}

export function canEditOversell(role: string | null | undefined): boolean {
  return role === "TENANT_ADMIN";
}
