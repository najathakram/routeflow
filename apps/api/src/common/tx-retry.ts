/**
 * SA-269: bounded retry for a SERIALIZABLE transaction whose body is idempotent.
 *
 * Postgres aborts one side of a serialization conflict (40001) or a deadlock (40P01). Prisma 7
 * surfaces either as P2034, or unwrapped as a `DriverAdapterError` of kind TransactionWriteConflict.
 * Re-running the WHOLE transaction takes a fresh snapshot, so a conflict that existed only because a
 * concurrent writer committed mid-transaction converges on the next attempt.
 *
 * Same house shape as REG-B108's MAX_SETTLE_ATTEMPTS loop (orders.service.ts changeStatus): 3
 * attempts, 100 ms then 300 ms backoff. Unlike that loop, any OTHER error propagates at once, and
 * exhausting the attempts propagates the last conflict: nothing is swallowed, the caller decides.
 */
import { HttpException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "./api-error-codes";

export const TX_CONFLICT_MAX_ATTEMPTS = 3;
/** 100 ms then 300 ms between attempts (exported so a caller with its own loop backs off the same way). */
export const TX_CONFLICT_BACKOFF_MS = [100, 300];
const logger = new Logger("tx-retry");

/** The conflict's SQLSTATE (40001 / 40P01) in any shape Prisma 7 or `pg` reports it, else null. */
export function txConflictState(err: any): string | null {
  // An HttpException is a validated rejection, never a conflict, whatever its text says (REG-B267-I).
  if (!err || err instanceof HttpException) return null;
  const state =
    err.meta?.driverAdapterError?.cause?.originalCode ??
    err.cause?.originalCode ??
    err.meta?.code ??
    err.code;
  if (state === "40001" || state === "40P01") return state;
  if (err.code === "P2034") return "P2034";
  if (err.name === "DriverAdapterError" && err.cause?.kind === "TransactionWriteConflict") {
    return "TransactionWriteConflict";
  }
  return null;
}

/** Runs `run` (one whole transaction), re-running it only on a write conflict, at most 3 times. */
export async function retryOnTxConflict<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const state = txConflictState(err);
      if (!state || attempt >= TX_CONFLICT_MAX_ATTEMPTS) throw err;
      logger.warn(
        `${label}: transaction conflict ${state}, retry ${attempt + 1}/${TX_CONFLICT_MAX_ATTEMPTS}`,
      );
      await new Promise((r) => setTimeout(r, TX_CONFLICT_BACKOFF_MS[attempt - 1] ?? 300));
    }
  }
}

/**
 * `retryOnTxConflict` whose EXHAUSTED retries answer a coded, retryable 503 LOCK_UNAVAILABLE with `message` (nothing was
 * saved), instead of the raw 40P01 / 40001 / P2034 that surfaced as an uncoded 500. Any other error propagates untouched. The
 * one mapping behind `retryCreditTx`, `retryRouteTx` and the parked-reversal resolve.
 */
export async function retryTxBusy<T>(
  label: string,
  run: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await retryOnTxConflict(label, run);
  } catch (err) {
    if (!txConflictState(err)) throw err;
    throw new ServiceUnavailableException({ code: API_ERROR_CODES.LOCK_UNAVAILABLE, message });
  }
}

/**
 * `retryOnTxConflict` for the credit-spend transactions: when the retries are EXHAUSTED the caller
 * gets a coded, retryable 503 (nothing was saved) instead of the raw P2034 that surfaced as an
 * uncoded 500. Any other error propagates untouched.
 */
export const retryCreditTx = <T>(label: string, run: () => Promise<T>): Promise<T> =>
  retryTxBusy(
    label,
    run,
    "Another change to these credits was in progress. Nothing was saved; please retry.",
  );

/**
 * `retryOnTxConflict` for the route / run / stop transactions (completeStop, completeWithPayment, a
 * run's terminal status move): when the retries are EXHAUSTED the caller gets a coded, retryable 503
 * (nothing was saved) instead of the raw 40P01 / 40001 / P2034 that surfaced as an uncoded 500.
 * Any other error propagates untouched.
 */
export const retryRouteTx = <T>(label: string, run: () => Promise<T>): Promise<T> =>
  retryTxBusy(
    label,
    run,
    "Someone else is updating this route. Nothing was saved; please try again.",
  );
