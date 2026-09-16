/**
 * Shared guard against financial-total manipulation (B451 gap 4): a
 * component going negative, or a discount exceeding what it's discounting.
 * One implementation for every create/recompute path that derives a total
 * from client-influenced components — orders, estimates, vendor-bills. Each
 * DOES ITS OWN rounding/derivation first (this only validates the already-
 * computed numbers); invoices.service.ts has its own equivalent inline
 * checks (lines 469-502) and is not yet migrated to this shared guard.
 */
export class MoneyInvariantError extends Error {
  readonly code = "MONEY_INVARIANT" as const;

  constructor(message: string) {
    super(message);
    this.name = "MoneyInvariantError";
  }
}

export interface MoneyInvariantInput {
  subtotal: number;
  discount?: number;
  tax?: number;
  shipping?: number;
  total: number;
}

/**
 * Throws `MoneyInvariantError` when:
 *  - any component (subtotal, discount, tax, shipping, total) is negative
 *  - discount exceeds subtotal
 *
 * `total < 0` is covered by the negative-component check above — a caller
 * never needs a second explicit check for it.
 */
export function assertMoneyInvariants(input: MoneyInvariantInput): void {
  const { subtotal, discount = 0, tax = 0, shipping = 0, total } = input;
  const components: [string, number][] = [
    ["subtotal", subtotal],
    ["discount", discount],
    ["tax", tax],
    ["shipping", shipping],
    ["total", total],
  ];
  for (const [name, value] of components) {
    if (value < 0) {
      throw new MoneyInvariantError(`${name} cannot be negative (${value}).`);
    }
  }
  if (discount > subtotal) {
    throw new MoneyInvariantError(`discount (${discount}) cannot exceed subtotal (${subtotal}).`);
  }
}
