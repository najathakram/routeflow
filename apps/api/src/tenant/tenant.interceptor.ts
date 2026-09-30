import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { TenantContextService } from "./tenant-context.service";
import { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * Global singleton interceptor that reads tenantId from the authenticated JWT
 * payload and runs the remainder of the request inside an AsyncLocalStorage
 * context so TenantContextService.get() works anywhere in the call chain.
 * Must run after JwtAuthGuard. SA-619: it also tags the context's kind: TENANT (a JWT with a
 * tenant), SUPER_ADMIN (an authenticated user with no tenant) or ANONYMOUS (no user).
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload | undefined;
    const tenantId = user?.tenantId ?? null;
    // Only a platform admin is SUPER_ADMIN. A buyer principal ({ type: "BUYER" }, no tenant, no role) and
    // any other tenant-less user are ANONYMOUS, so the dark phase sees their context-less queries.
    const superAdmin = user?.role === "SUPER_ADMIN" && user.type !== "BUYER";
    return this.tenantContext.run(
      tenantId,
      () => next.handle(),
      superAdmin ? "SUPER_ADMIN" : "ANONYMOUS",
    );
  }
}
