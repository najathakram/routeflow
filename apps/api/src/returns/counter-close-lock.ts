/**
 * SA-740r2 item 6 / SA-750r3: the counter DAY-CLOSE lock, taken by the refund paths.
 *
 * Key = `(hashtext('counter-close'), hashtext(tenantId || ':' || registerKey))`. The end-of-day close takes the EXCLUSIVE form
 * (`pg_advisory_xact_lock`) and reads its cutoff from the clock AFTER the lock is granted; the tender, the pickup and the
 * refunds take the SHARED form (`pg_advisory_xact_lock_shared`) around their write, so the close waits for every write in
 * flight (a refund's `refundedAt` is the app clock) while the writes never serialize with each other. A refund takes it as
 * the FIRST statement of its transaction, before the Return row lock: counter-close -> Return -> Orders -> Invoices.
 */

/** The register of a till that has no register picker (one till, R20-10): every counter order without a key is on it. */
export const COUNTER_DEFAULT_REGISTER = "main";

export const counterCloseKeyOf = (tenantId: string, registerKey: string): string =>
  `${tenantId}:${registerKey}`;

/**
 * The register a refund of this order is counted on: a COUNTER order's `registerKey` (null reads as the default register,
 * counter orders created before the seam shipped), else null. A non-counter order's refund is not a till event (it is not in
 * the day's window), so it takes no close lock.
 */
export function registerKeyOfOrder(
  order: { counterSale?: boolean | null; registerKey?: string | null } | null | undefined,
): string | null {
  if (!order || order.counterSale !== true) return null;
  return order.registerKey ?? COUNTER_DEFAULT_REGISTER;
}

/** Takes the SHARED close lock on the caller's own transaction. MUST be the transaction's first statement. */
export async function lockCounterClose(
  tx: { $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<unknown> },
  tenantId: string,
  registerKey: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('counter-close'), hashtext(${counterCloseKeyOf(tenantId, registerKey)}))`;
}
