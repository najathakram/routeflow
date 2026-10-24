import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { routeHitKey } from "./route-hit-key";
import { RouteHitsService } from "./route-hits.service";

/**
 * W3: global interceptor that counts each matched route template (see RouteHitsService). It runs AFTER the
 * route guards, so it counts calls that were authenticated and allowed (401/403/throttled calls are not
 * counted). It counts BEFORE `next.handle()`, so a handler that THROWS is still counted. It never awaits,
 * never touches Redis on the request path and never fails a request.
 */
@Injectable()
export class RouteHitsInterceptor implements NestInterceptor {
  constructor(private readonly hits: RouteHitsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() === "http") {
      try {
        this.hits.record(routeHitKey(context.switchToHttp().getRequest()));
      } catch {
        // counting must never affect a request
      }
    }
    return next.handle();
  }
}
