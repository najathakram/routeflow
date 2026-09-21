import {
  loadCreditExposure,
  OPEN_ORDER_STATUSES,
  type ExposureDb,
} from "../invoices/credit-exposure";

/** At most this many over-limit customers are logged per run start (the rest are one summary line). */
export const RUN_CREDIT_LOG_CAP = 20;
const ORDER_NUMBERS_PER_LINE = 10;
/** A background job: at most this many customers of one run are looked at (2 reads each). */
const MAX_CUSTOMERS_OBSERVED = 50;

export interface RunCreditObservationDeps {
  /** A tenant-scoped client (`forTenant()`), captured synchronously by the caller. */
  db: ExposureDb & { customer: { findMany(args: any): PromiseLike<any[]> } };
  logger: { warn(message: string): void };
  tenantId: string | null;
}

/**
 * B585 — OBSERVATION ONLY. When a run starts, log one warning per customer on it whose credit
 * exposure (the ONE shared derivation, the figure the hard block compares) is over their limit:
 * tenant, run, customer id, order NUMBERS, exposure and limit — ids and figures only. It is how the
 * owner sees which customers a `credit_limit.enforce_new_orders` flip would stop at the door,
 * before flipping it. It NEVER changes the run: it does not throw, block, write or gate on anything
 * (the caller does not await it), and a failed read is one warn line. It is flag-blind like the hard
 * block today (`PLAN_FLAG_ENFORCEMENT` off): revisit if that ever flips on. One line per customer
 * per run start, capped at `RUN_CREDIT_LOG_CAP`; a run of more than 1000 open orders is truncated.
 */
export async function observeRunCredit(
  { db, logger, tenantId }: RunCreditObservationDeps,
  runId: string,
): Promise<void> {
  try {
    const orders: Array<{ orderNumber: string | null; customerId: string }> =
      await db.order.findMany({
        where: { routeRunId: runId, status: { in: OPEN_ORDER_STATUSES } },
        select: { orderNumber: true, customerId: true },
        take: 1000,
      });
    const numbersByCustomer = new Map<string, string[]>();
    for (const o of orders) {
      const numbers = numbersByCustomer.get(o.customerId) ?? [];
      numbers.push(o.orderNumber ?? "?");
      numbersByCustomer.set(o.customerId, numbers);
    }
    if (numbersByCustomer.size === 0) return;
    const customers: Array<{ id: string; creditLimit: unknown }> = await db.customer.findMany({
      where: { id: { in: [...numbersByCustomer.keys()].slice(0, MAX_CUSTOMERS_OBSERVED) } },
      select: { id: true, creditLimit: true },
    });

    let over = 0;
    for (const c of customers) {
      if (c.creditLimit == null) continue;
      const limit = Number(c.creditLimit);
      if (!Number.isFinite(limit)) continue;
      const { counted } = await loadCreditExposure(db, c.id);
      if (!(counted > limit)) continue;
      if (++over > RUN_CREDIT_LOG_CAP) continue;
      const numbers = numbersByCustomer.get(c.id) ?? [];
      const shown = numbers.slice(0, ORDER_NUMBERS_PER_LINE).join(",");
      logger.warn(
        `run start (observation only): customer over credit limit: tenant=${tenantId ?? "none"} ` +
          `run=${runId} customer=${c.id} orders=${shown}${numbers.length > ORDER_NUMBERS_PER_LINE ? `,+${numbers.length - ORDER_NUMBERS_PER_LINE}` : ""} ` +
          `exposure=${counted} limit=${limit}`,
      );
    }
    if (over > RUN_CREDIT_LOG_CAP) {
      logger.warn(
        `run start (observation only): ${over - RUN_CREDIT_LOG_CAP} more customer(s) over their credit limit on run=${runId} not listed`,
      );
    }
  } catch {
    // Observation must never fail a run start; a failed read is worth exactly one line.
    try {
      logger.warn(`run start (observation only): credit observation unavailable for run=${runId}`);
    } catch {
      /* the logger itself failed: nothing left to do */
    }
  }
}
