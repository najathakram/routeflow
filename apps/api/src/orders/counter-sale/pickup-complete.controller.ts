import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { requireIdempotencyKey } from "./required-idempotency-key";
import { PickupCompleteDto } from "./pickup-complete.dto";
import { PickupCompleteService } from "./pickup-complete.service";

/**
 * POST /orders/:id/pickup-complete — staff hand a PICKUP order over at the till: DELIVERED + invoice sent
 * + tender recorded in one call. OPERATOR admits TENANT_ADMIN through RolesGuard's hierarchy. A payment
 * problem after the hand-over is a 200 body (`paymentRecorded: false`), never an error. The
 * `Idempotency-Key` header is REQUIRED (400 IDEMPOTENCY_KEY_REQUIRED), same character rules as the counter sale.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class PickupCompleteController {
  constructor(private readonly pickup: PickupCompleteService) {}

  @Post(":id/pickup-complete")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async complete(
    @Param("id") id: string,
    @Body() dto: PickupCompleteDto,
    @CurrentUser() user: JwtPayload,
    @Headers("Idempotency-Key") rawKey?: string,
  ) {
    return this.pickup.complete(id, dto, user, requireIdempotencyKey(rawKey, "complete a pickup"));
  }
}
