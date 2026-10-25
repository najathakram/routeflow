import { FulfillPath } from "@prisma/client";
import { COUNTER_DEFAULT_REGISTER } from "@routeflow/pricing";

/**
 * SA-740r2 item 6 / SA-750r3: the counter DAY-CLOSE lock, taken by the refund paths.
 *
 * Key = `(hashtext('counter-close'), hashtext(tenantId || ':' || registerKey))`. The end-of-day close takes the EXCLUSIVE form
 * (`pg_advisory_xact_lock`) and reads its cutoff from the clock AFTER the lock is granted; the tender, the pickup and the
 * refunds take the SHARED form (`pg_advisory_xact_lock_shared`) around their write, so the close waits for every write in
 * flight (a refund's `refundedAt` is the database clock, `dbClockNow`) while the writes never serialize with each other. A refund takes it as
 * the FIRST statement of its transaction, before the Return row lock: counter-close -> Return -> Orders -> Invoices.
 */

/** The register of a till that has no register picker (one till, R20-10): every counter order without a key is on it. */
export { COUNTER_DEFAULT_REGISTER };

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

/**
 * W-829 / SA-932 F: the register a REFUND of this sale is counted on. A counter order (`registerKeyOfOrder`), and also a Store
 * pickup sale whose hand-over stamped a register: its tender is already till cash of that register (SA-750r3), so its cash
 * refund must leave the same drawer, take the same close lock and be refused in a closed window. The stamp is write-once
 * (pickup-complete.service.ts sets it only while null and refuses a different key), so an unlocked read of it is safe. A pickup never
 * handed over at a till has no stamp, and any other path (route, ship) is not a till event.
 */
export function tillRegisterOfSale(
  order:
    | { counterSale?: boolean | null; registerKey?: string | null; fulfillPath?: string | null }
    | null
    | undefined,
): string | null {
  const counter = registerKeyOfOrder(order);
  if (counter) return counter;
  return order?.fulfillPath === FulfillPath.PICKUP && order.registerKey ? order.registerKey : null;
}

/**
 * W-829: a refund that took NO close lock because the sale read as unstamped (an unlocked read) re-reads the stamp here, on its
 * own transaction, after the Order row lock. A hand-over stamps the register on that same row, so once this transaction holds the
 * lock the answer cannot change until it ends. True means the sale was stamped while the refund waited: the caller must stop
 * (retryable 409, nothing written) and retry, which then takes the close lock as its first statement. A counter order or an
 * already stamped pickup is write-once, so a refund that locked already has the right key (false).
 */
export async function tillRegisterStampedUnderLock(
  tx: {
    order: {
      findFirst: (args: any) => Promise<{
        counterSale?: boolean | null;
        registerKey?: string | null;
        fulfillPath?: string | null;
      } | null>;
    };
  },
  orderId: string,
  lockedRegister: string | null,
): Promise<boolean> {
  if (lockedRegister) return false;
  const now = await tx.order.findFirst({
    where: { id: orderId },
    select: { counterSale: true, registerKey: true, fulfillPath: true },
  });
  return tillRegisterOfSale(now) !== null;
}

/**
 * The database clock (`clock_timestamp()`), read on the caller's transaction AFTER the close lock is granted. A refund stamps
 * `refundedAt` with this, the clock the close reads its cutoff from (SA-750r2), so a refund committed after a cutoff can never
 * be stamped before it by a skewed app clock. Falls back to the app clock only when the driver returns no row (mocked clients).
 */
export async function dbClockNow(tx: {
  $queryRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<unknown>;
}): Promise<Date> {
  const rows = (await tx.$queryRaw`SELECT clock_timestamp() AS now`) as
    Array<{ now?: Date }> | undefined;
  const now = rows?.[0]?.now;
  return now instanceof Date ? now : new Date();
}

/** Takes the SHARED close lock on the caller's own transaction. MUST be the transaction's first statement. */
export async function lockCounterClose(
  tx: { $executeRaw: (strings: TemplateStringsArray, ...values: any[]) => Promise<unknown> },
  tenantId: string,
  registerKey: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('counter-close'), hashtext(${counterCloseKeyOf(tenantId, registerKey)}))`;
}
