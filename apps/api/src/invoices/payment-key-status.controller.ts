import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { requireIdempotencyKey } from "../orders/counter-sale/required-idempotency-key";
import { PaymentKeyStatusService } from "./payment-key-status.service";

/**
 * SA-824: GET /invoices/payments/by-key/:key, the "Check payment status" answer. Same roles as the payment
 * writers (OPERATOR, which admits TENANT_ADMIN). Two segments deep after `payments`, so
 * `GET payments/:paymentId` can never take it.
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
}
