import { Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { requireIdempotencyKey } from "../orders/counter-sale/required-idempotency-key";
import { PaymentKeyStatusService } from "./payment-key-status.service";

/**
 * SA-824: GET /invoices/payments/by-key/:key (read-only) and POST /invoices/payments/by-key/:key/resolve (the
 * "Check payment status" answer that closes the race: found, or a tombstone). Same roles as the payment
 * writers (OPERATOR, which admits TENANT_ADMIN), tenant-scoped. Two segments deep after `payments`, so
 * `GET payments/:paymentId` / `POST payments/:paymentId/image` can never take them.
 */
@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
export class PaymentKeyStatusController {
  constructor(private readonly status: PaymentKeyStatusService) {}

  @Get("payments/by-key/:key")
  async byKey(@Param("key") rawKey: string) {
    return this.status.byKey(requireIdempotencyKey(rawKey, "check a payment"));
  }

  /** SA-824 race ruling 3: { state: "found", ... } | { state: "tombstoned" }; 409 PAYMENT_KEY_IN_FLIGHT. */
  @Post("payments/by-key/:key/resolve")
  @HttpCode(200)
  async resolve(@Param("key") rawKey: string, @CurrentUser() user: JwtPayload) {
    return this.status.resolve(requireIdempotencyKey(rawKey, "check a payment"), user);
  }
}
