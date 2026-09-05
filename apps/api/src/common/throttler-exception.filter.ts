import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import type { Response } from "express";
import { resolveLoginThrottle } from "../auth/login-throttle.config";

/**
 * RF-160: Intercepts ThrottlerException (429) and adds the Retry-After header
 * so clients know how long to wait before retrying.
 *
 * The header value is derived from the ThrottlerException message which
 * NestJS sets to "Too Many Requests". We default to 60 s; for the login
 * endpoint the window comes from the login-throttle config (pB10 —
 * AUTH_LOGIN_THROTTLE_TTL_MS, default 300 s) so the header can never drift
 * from the TTL the @Throttle decorator actually enforces.
 */
@Catch(ThrottlerException)
export class ThrottlerExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ThrottlerExceptionFilter.name);

  catch(exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ path: string; ip: string }>();

    // Default retry window; the login route's window comes from the same
    // login-throttle config the @Throttle decorator reads (default 300 s).
    const retryAfter = req.path?.includes("/auth/login")
      ? Math.max(1, Math.ceil(resolveLoginThrottle().ttl / 1000))
      : 60;

    this.logger.warn(`Rate limit hit: ${req.path} ip=${req.ip}`);

    // BUG-OPS1-5: NestJS's ThrottlerException.message exposes the internal
    // class name ("ThrottlerException: Too Many Requests"). Rewrite to a
    // plain, user-facing string so client UIs that render `error.message`
    // verbatim do not leak the implementation detail.
    const minutes = Math.max(1, Math.round(retryAfter / 60));
    const friendly = `Too many requests. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;

    res.status(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", String(retryAfter)).json({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: "Too Many Requests",
      message: friendly,
      retryAfter,
    });
  }
}
