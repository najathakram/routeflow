import { ExceptionFilter, HttpServer, INestApplication } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { LockConflictFilter } from "./lock-conflict.filter";
import { MulterExceptionFilter } from "./multer-exception.filter";
import { SentryExceptionFilter } from "./sentry-exception.filter";
import { ThrottlerExceptionFilter } from "./throttler-exception.filter";

/**
 * Registers the global exception filters (called by main.ts).
 *
 * ORDER IS LOAD-BEARING. Nest checks globally-registered filters in REVERSE registration order and
 * runs the first one whose `@Catch(...)` matches - it never falls through. So:
 *  - the catch-all `SentryExceptionFilter` is registered FIRST (checked last);
 *  - the narrow `@Catch(X)` filters (Throttler, Multer) come AFTER it or they are never reached;
 *  - `LockConflictFilter` is itself `@Catch()` (a lock error has no single class), so it must sit
 *    BEFORE the narrow filters (or it would shadow them) and it calls the catch-all itself for every
 *    error it does not own, so nothing else changes.
 */
export function buildGlobalExceptionFilters(httpAdapter: HttpServer): ExceptionFilter[] {
  const catchAll = new SentryExceptionFilter(httpAdapter);
  return [
    catchAll,
    new LockConflictFilter(catchAll),
    new ThrottlerExceptionFilter(),
    new MulterExceptionFilter(),
  ];
}

export function registerGlobalExceptionFilters(app: INestApplication): void {
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(...buildGlobalExceptionFilters(httpAdapter));
}
