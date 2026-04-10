import { ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";

/** Marks a buyer route as public (no BuyerJwtAuthGuard check). */
export const IS_PUBLIC_BUYER_KEY = "IS_PUBLIC_BUYER";
export const PublicBuyer = () => SetMetadata(IS_PUBLIC_BUYER_KEY, true);

@Injectable()
export class BuyerJwtAuthGuard extends AuthGuard("buyer-jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_BUYER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
