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
import { API_ERROR_CODES } from "../../common/api-error-codes";
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

  /**
   * Same rules as CounterSaleController.normalizeKey (1-128 printable ASCII, no spaces, REQUIRED). A copy, not
   * an import: that method is private to a file this lane does not edit; dedupe once both are on one branch.
   */
  private normalizeKey(raw: string | undefined): string {
    const key = raw?.trim();
    if (!key) {
      throw new BadRequestException({
        code: API_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        message: "Idempotency-Key header is required to complete a pickup",
      });
    }
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
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async complete(
    @Param("id") id: string,
    @Body() dto: PickupCompleteDto,
    @CurrentUser() user: JwtPayload,
    @Headers("Idempotency-Key") rawKey?: string,
  ) {
    return this.pickup.complete(id, dto, user, this.normalizeKey(rawKey));
  }
}
