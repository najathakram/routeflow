import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { TenantContextService } from "../tenant/tenant-context.service";

/**
 * Applied at the seller-scoped BuyerController class level.
 * Runs after the global TenantInterceptor (which sets null for buyer requests)
 * and overrides it with the correct tenantId resolved by BuyerSellerContextGuard.
 *
 * The inner AsyncLocalStorage.run() call shadows the outer null context,
 * so prisma.forTenant() scopes correctly for all downstream service calls.
 */
@Injectable()
export class BuyerTenantInterceptor implements NestInterceptor {
  constructor(private readonly tenantCtx: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest();
    const tenantId: string | undefined = req.buyerCustomer?.tenantId;
    if (!tenantId) return next.handle();
    return this.tenantCtx.run(tenantId, () => next.handle());
  }
}
