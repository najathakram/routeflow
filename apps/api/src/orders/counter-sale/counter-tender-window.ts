import {
  COUNTER_DEFAULT_REGISTER,
  counterCloseKeyOf,
  dbClockNow,
  registerKeyOfOrder,
} from "../../returns/counter-close-lock";
import { assertCounterWindowOpen } from "../../returns/counter-close-window";

/**
 * SA-750r3: what a till TENDER does for the end-of-day close, shared by the counter sale and the pickup hand-over.
 *
 * The tender runs on `withAdvisoryLock`'s pinned `counter-tender` connection, so the SHARED counter-close lock rides that same
 * connection (`sharedAlso`); the close takes the EXCLUSIVE form and reads its cutoff from `clock_timestamp()` after it, so it
 * waits for the write in flight. A COUNTER order is a till event, and so is every pickup hand-over TENDER (it passes the
 * register from `pickupRegisterOf`); any other order gets no lock, no clock read and no window check.
 */

/**
 * The register a pickup hand-over tender counts toward (SA-750r3, Train 4 meets day close): a counter order keeps its own
 * register (`registerKeyOfOrder`, a null key reads as 'main'); any other PICKUP order counts toward its STAMPED
 * `Order.registerKey`, else the request's `registerKey`, else 'main'. Blank reads as absent; the key is never case-folded.
 */
export function pickupRegisterOf(
  order: { counterSale?: boolean | null; registerKey?: string | null } | null | undefined,
  requested?: string | null,
): string {
  const counter = registerKeyOfOrder(order);
  if (counter) return counter;
  if (order?.registerKey) return order.registerKey;
  return requested && requested.trim() !== "" ? requested : COUNTER_DEFAULT_REGISTER;
}

/**
 * The `sharedAlso` option for this order's register, or undefined when the order is not on a till. An explicit `register`
 * (a pickup tender, see `pickupRegisterOf`) puts a non-counter order on that register's lock too.
 */
export function counterCloseShared(
  tenantId: string | null | undefined,
  order: TillOrder,
  register?: string,
): { family: "counter-close"; key: string } | undefined {
  const registerKey = register ?? registerKeyOfOrder(order);
  return tenantId && registerKey
    ? { family: "counter-close", key: counterCloseKeyOf(tenantId, registerKey) }
    : undefined;
}

type ClockClient = Parameters<typeof dbClockNow>[0];
type WindowClient = Parameters<typeof assertCounterWindowOpen>[0];
type TillOrder = { counterSale?: boolean | null; registerKey?: string | null } | null | undefined;

/**
 * Called with the shared close lock HELD and immediately before a payment row is written: reads the database clock, refuses
 * 409 COUNTER_SALE_DAY_CLOSED when that instant falls in a closed window of the order's register, and answers the instant as
 * the ISO `paidAt` the payment must carry (the clock the close reads its cutoff from, never the app clock). A non-counter
 * order answers undefined without touching the database, unless an explicit `register` is given (a pickup tender).
 */
export async function counterTenderPaidAt(
  db: ClockClient & { forTenant: () => WindowClient },
  tenantId: string | null | undefined,
  order: TillOrder,
  register?: string,
): Promise<string | undefined> {
  const registerKey = register ?? registerKeyOfOrder(order);
  if (!tenantId || !registerKey) return undefined;
  const at = await dbClockNow(db);
  await assertCounterWindowOpen(db.forTenant(), tenantId, registerKey, at);
  return at.toISOString();
}
