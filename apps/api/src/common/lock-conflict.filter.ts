import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import * as Sentry from "@sentry/node";
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
 * It maps two things, and only these:
 *  1. what `stockTxRetryState` recognises (the one SQLSTATE predicate, in every shape the stack
 *     surfaces; it already rejects every HttpException): answered with the standard body;
 *  2. an HttpException that is ALREADY the 503 `LOCK_UNAVAILABLE` (the exhausted `retryStockTx`, the
 *     count committer's 503 with `committedLines` / `totalLines`): it keeps its status and its body
 *     exactly - the filter only adds `Retry-After`. Every other HttpException (a CAS 409,
 *     MERGE_IN_PROGRESS, STOCK_COUNT_COMMITTING, a 503 with another code) is handed on untouched.
 * Everything else goes, unchanged, to `next` - the catch-all SentryExceptionFilter.
 *
 * NEVER SILENT (SA-767 r-note 5 SA-4): the mapping covers every route, so each mapped error is also
 * reported to Sentry at WARNING level, fingerprinted by route + code, in addition to the warn log. The
 * filter renders the response itself (the catch-all is not called), so there is exactly one event; a
 * Sentry that is not initialised - or that throws - is a no-op that never touches the response.
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
    const mapped = host.getType() === "http" ? this.classify(exception) : null;
    if (!mapped) {
      this.next.catch(exception, host);
      return;
    }
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    this.logger.warn(
      `${req?.method ?? "?"} ${req?.originalUrl ?? req?.url ?? "?"}: stock lock conflict ${mapped.code}` +
        ` -> 503 ${API_ERROR_CODES.LOCK_UNAVAILABLE}`,
    );
    this.report(exception, req, mapped.code);
    res
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .header("Retry-After", String(LOCK_RETRY_AFTER_SECONDS))
      .json(mapped.body);
  }

  /** What this filter owns: the SQLSTATE family, or an HttpException that already is the coded 503. */
  private classify(exception: unknown): { code: string; body: object } | null {
    const state = stockTxRetryState(exception);
    if (state) return { code: state, body: { ...LOCK_UNAVAILABLE_BODY } };
    if (
      exception instanceof HttpException &&
      exception.getStatus() === (HttpStatus.SERVICE_UNAVAILABLE as number)
    ) {
      const body = exception.getResponse();
      if (
        body !== null &&
        typeof body === "object" &&
        (body as { code?: unknown }).code === API_ERROR_CODES.LOCK_UNAVAILABLE
      ) {
        return { code: API_ERROR_CODES.LOCK_UNAVAILABLE, body };
      }
    }
    return null;
  }

  /**
   * One Sentry event at warning level, grouped by route + code. The route is the MATCHED pattern
   * (`/orders/:id/status`), not the URL, so ids and queries never split a group.
   */
  private report(exception: unknown, req: Request | undefined, code: string): void {
    try {
      const pattern = req?.route?.path
        ? `${req.baseUrl ?? ""}${req.route.path}`
        : String(req?.originalUrl ?? req?.url ?? "?").split("?")[0];
      const route = `${req?.method ?? "?"} ${pattern}`;
      const user = (req as { user?: { tenantSlug?: string; tenantId?: string } } | undefined)?.user;
      Sentry.withScope((scope) => {
        scope.setLevel("warning");
        scope.setFingerprint([route, code]);
        scope.setTag("path", route);
        scope.setTag("lock_conflict", code);
        const tenant = user?.tenantSlug ?? user?.tenantId;
        if (tenant) scope.setTag("tenant", tenant);
        Sentry.captureException(exception);
      });
    } catch (err) {
      this.logger.debug(`lock conflict not reported to Sentry: ${(err as Error)?.message}`);
    }
  }
}
