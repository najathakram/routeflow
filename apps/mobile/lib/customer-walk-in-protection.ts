/** Why the tenant's system walk-in customer (counter sales) offers no Delete (mirrors the web customer page). */
export const WALK_IN_PROTECTED_COPY =
  "This is the walk-in customer for counter sales. It can't be deactivated, removed or merged.";

/** The walk-in customer can never be removed: the server refuses it with WALK_IN_PROTECTED. */
export function canDeleteCustomer(customer: { isWalkIn?: boolean | null }): boolean {
  return customer.isWalkIn !== true;
}
