import { ArgumentsHost, Catch, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import * as Sentry from "@sentry/node";

/**
 * Reports unexpected (non-HttpException, or 5xx) errors to Sentry with the
 * tenant tagged, then defers to Nest's default handling. Inert when Sentry
 * is disabled (capture becomes a no-op).
 */
@Catch()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    if (status >= 500) {
      const req = host.switchToHttp().getRequest();
      const user = req?.user as
        { tenantSlug?: string; tenantId?: string; sub?: string; username?: string } | undefined;
      Sentry.withScope((scope) => {
        if (user?.tenantSlug ?? user?.tenantId) {
          scope.setTag("tenant", user.tenantSlug ?? user.tenantId!);
        }
        if (user?.sub) scope.setUser({ id: user.sub, username: user.username });
        scope.setTag("path", req?.originalUrl ?? req?.url ?? "");
        Sentry.captureException(exception);
      });
    }
    super.catch(exception, host);
  }
}
