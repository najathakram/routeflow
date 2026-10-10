import type { FulfillPath } from "@routeflow/types";

/**
 * A customer's default fulfilment path as the edit form carries it (SA-655). The form used to coerce
 * anything that was not SHIP to ROUTE, which silently rewrote a PICKUP customer on save. The form value
 * now preserves ROUTE | SHIP | PICKUP; anything else (missing, a legacy payload) is the column default ROUTE.
 */
export function formFulfillPath(value: unknown): FulfillPath {
  return value === "SHIP" || value === "PICKUP" ? value : "ROUTE";
}

/**
 * What the create/update payload may carry. The write API refuses PICKUP as a customer default
 * (WRITABLE_FULFILL_PATHS is ROUTE | SHIP), so a PICKUP customer's save OMITS the field (the server keeps
 * the stored value) instead of sending ROUTE (a silent rewrite) or PICKUP (a 400).
 */
export function writableFulfillPath(value: FulfillPath | undefined): "ROUTE" | "SHIP" | undefined {
  if (value === "PICKUP") return undefined;
  return value ?? "ROUTE";
}

/**
 * The create/update payload value: both rules at once. A PICKUP customer's save OMITS the field
 * (`writableFulfillPath`: the server keeps the stored value, never a silent rewrite or a 400); every
 * other value goes through the account's capability preselect (`pickForm`), so a path the account
 * does not offer is never submitted (a ROUTE on a ship-only account becomes SHIP).
 */
export function payloadFulfillPath(
  value: FulfillPath | undefined,
  pickForm: (customerPath?: string | null) => "ROUTE" | "SHIP",
): "ROUTE" | "SHIP" | undefined {
  return writableFulfillPath(value) === undefined ? undefined : pickForm(value);
}
