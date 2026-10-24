import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import type { SendReceiptResponse } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { ReceiptService } from "./receipt.service";
import { SendReceiptDto } from "./send-receipt.dto";

/**
 * POST /orders/:id/receipt (SA-751r): send a receipt for any order with a live invoice (counter, delivered or picked up).
 * OPERATOR admits TENANT_ADMIN through RolesGuard's hierarchy. The audit trail is the global interceptor's row (who, when)
 * plus the EmailDelivery row (to, status) the send writes.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class ReceiptController {
  constructor(private readonly receipts: ReceiptService) {}

  @Post(":id/receipt")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async send(@Param("id") id: string, @Body() dto: SendReceiptDto): Promise<SendReceiptResponse> {
    return this.receipts.send(id, dto);
  }
}
