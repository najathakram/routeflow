import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { TenantContextService } from "./tenant-context.service";
import { runWithImpersonation } from "./impersonation-context";
import { JwtPayload } from "../auth/jwt-payload.interface";

/**
 * Global singleton interceptor that reads tenantId from the authenticated JWT
 * payload and runs the remainder of the request inside an AsyncLocalStorage
 * context so TenantContextService.get() works anywhere in the call chain.
 * Must run after JwtAuthGuard.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    const user = req.user as JwtPayload | undefined;
    const tenantId = user?.tenantId ?? null;
    // SA-970 §2.3: the add-on writer reads the impersonating admin from this context.
    return runWithImpersonation(user?.impersonatedBy, () =>
      this.tenantContext.run(tenantId, () => next.handle()),
    );
  }
}
