import { Catch, HttpStatus, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { API_ERROR_CODES } from "./api-error-codes";
import { stockTxRetryState } from "./tx-retry";

/**
 * The coded body of the backstop 503. The copy never names the holder (a sale cannot know who holds
 * the lock: a count commit, a receive, another sale); it matches the SA r-note 2 (c) wording.
 */
export const LOCK_UNAVAILABLE_BODY = {
  code: API_ERROR_CODES.LOCK_UNAVAILABLE,
  message: "Stock is busy being updated — try again in a moment.",
} as const;

/** Seconds a client should wait before retrying (a stock lock window is 5 s at most). */
export const LOCK_RETRY_AFTER_SECONDS = 2;

/**
 * SA-767 r-note 3 (a): the global BACKSTOP for a stock-lock failure that no handler turned into a
 * coded response. After `retryStockTx` (or on a path that has no retry), a Postgres lock wait that
 * gave up (55P03), deadlock (40P01), serialization failure (40001) or Prisma's P2028 / P2034 would
 * reach the catch-all as an UNCODED 500. This filter answers it as a retryable 503
 * `LOCK_UNAVAILABLE` with `Retry-After: 2`, and logs at warn with the route and the code.
 *
 * It maps ONLY what `stockTxRetryState` recognises (the one SQLSTATE predicate, in every shape the
 * stack surfaces; it already rejects every HttpException, so a CAS 409, MERGE_IN_PROGRESS,
 * STOCK_COUNT_COMMITTING or an existing 503 is never touched). Everything else is handed, unchanged,
 * to `next` - the catch-all SentryExceptionFilter.
 *
 * WHY IT DELEGATES BY HAND: Nest picks the FIRST matching filter (checked in reverse registration
 * order) and never falls through to the next, and a `@Catch()` filter matches every error. So this
 * filter is `@Catch()` and calls the catch-all itself for anything it does not own. Register it
 * with `registerGlobalExceptionFilters` (the order is pinned in lock-conflict.filter.spec.ts).
 */
@Catch()
export class LockConflictFilter implements ExceptionFilter {
  private readonly logger = new Logger(LockConflictFilter.name);

  constructor(private readonly next: ExceptionFilter) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const state = host.getType() === "http" ? stockTxRetryState(exception) : null;
    if (!state) {
      this.next.catch(exception, host);
      return;
    }
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    this.logger.warn(
      `${req?.method ?? "?"} ${req?.originalUrl ?? req?.url ?? "?"}: stock lock conflict ${state}` +
        ` -> 503 ${API_ERROR_CODES.LOCK_UNAVAILABLE}`,
    );
    res
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .header("Retry-After", String(LOCK_RETRY_AFTER_SECONDS))
      .json({ ...LOCK_UNAVAILABLE_BODY });
  }
}
