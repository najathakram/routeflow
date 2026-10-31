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
 * The create/update payload value: three rules at once.
 *  - An account whose default is PICKUP (pickup, or pickup and ship) sends NO path at all (SA-1066 M9). The form can only
 *    hold ROUTE | SHIP, so `pickForm` would turn PICKUP into SHIP, a path nobody chose (the picker is hidden there): a create is
 *    then stored as ROUTE, which reads as no preference, and an update keeps what is stored. `staffDefault` is required so
 *    every caller states it. If a picker is ever added for these accounts, this condition changes with it.
 *  - A PICKUP customer's save OMITS the field (`writableFulfillPath`: the server keeps the stored value, never a silent
 *    rewrite or a 400).
 *  - Every other value goes through the account's capability preselect (`pickForm`), so a path the account does not offer
 *    is never submitted (a ROUTE on a ship-only account becomes SHIP).
 */
export function payloadFulfillPath(
  value: FulfillPath | undefined,
  pickForm: (customerPath?: string | null) => "ROUTE" | "SHIP",
  staffDefault: string | null | undefined,
): "ROUTE" | "SHIP" | undefined {
  if (staffDefault === "PICKUP") return undefined;
  return writableFulfillPath(value) === undefined ? undefined : pickForm(value);
}
