import {
  BadRequestException,
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
import { PickupCompleteDto } from "./pickup-complete.dto";
import { PickupCompleteService } from "./pickup-complete.service";

/**
 * POST /orders/:id/pickup-complete — staff hand a PICKUP order over at the till: DELIVERED + invoice sent
 * + tender recorded in one call. OPERATOR admits TENANT_ADMIN through RolesGuard's hierarchy. A payment
 * problem after the hand-over is a 200 body (`paymentRecorded: false`), never an error.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class PickupCompleteController {
  constructor(private readonly pickup: PickupCompleteService) {}

  /** Same contract as OrdersController.normalizeIdempotencyKey: blank = no key; 1-128 printable ASCII, no spaces. */
  private normalizeKey(raw: string | undefined): string | undefined {
    if (raw == null) return undefined;
    const key = raw.trim();
    if (!key) return undefined;
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new BadRequestException(
        "Idempotency-Key must be at most 128 printable characters with no spaces",
      );
    }
    return key;
  }

  @Post(":id/pickup-complete")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  async complete(
    @Param("id") id: string,
    @Body() dto: PickupCompleteDto,
    @CurrentUser() user: JwtPayload,
    @Headers("Idempotency-Key") rawKey?: string,
  ) {
    return this.pickup.complete(id, dto, user, this.normalizeKey(rawKey));
  }
}
