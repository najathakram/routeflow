import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RequirePermission } from "../auth/permissions/permission.decorators";
import { ReadyForPickupService } from "./ready-for-pickup.service";

/**
 * POST /orders/:id/ready-for-pickup (W-1043, SA-1062 MUST 15): staff mark a PICKUP order Ready for pickup and are
 * told what happened to the customer's email. No money moves, so no till permission and no Idempotency-Key: a
 * repeat press answers `{ alreadyReady: true }` and sends nothing. OPERATOR admits TENANT_ADMIN through RolesGuard.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class ReadyForPickupController {
  constructor(private readonly ready: ReadyForPickupService) {}

  @RequirePermission("ORDERS", "DISPATCH")
  @Post(":id/ready-for-pickup")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  markReady(@Param("id") id: string, @CurrentUser() user: JwtPayload) {
    return this.ready.markReady(id, user);
  }
}
