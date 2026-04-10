import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { BuyerJwtPayload } from "../interfaces/buyer-jwt-payload.interface";

export const CurrentBuyer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): BuyerJwtPayload =>
    ctx.switchToHttp().getRequest().user,
);

export const CurrentBuyerCustomer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().buyerCustomer,
);
