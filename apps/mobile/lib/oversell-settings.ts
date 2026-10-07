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
  section: "Ordering",
  label: "Let customers order items that are out of stock",
  hint:
    "When on, a customer's order can take an item's stock below zero and the order is a " +
    "backorder. Staff can always order items that are out of stock.",
  readOnly: "Only an admin can change this setting.",
  loadFailed: "Couldn't load the out-of-stock ordering setting.",
  saveFailed: "Couldn't save the out-of-stock ordering setting.",
  savedOn: "Customers can now order items that are out of stock",
  savedOff: "Customers can no longer order items that are out of stock",
} as const;

export function oversellIsOn(mode: unknown): boolean {
  return mode === "backorder";
}

export function nextOversellMode(currentlyOn: boolean): InventoryBuyerOversellMode {
  return currentlyOn ? "off" : "backorder";
}

export function canEditOversell(role: string | null | undefined): boolean {
  return role === "TENANT_ADMIN";
}
