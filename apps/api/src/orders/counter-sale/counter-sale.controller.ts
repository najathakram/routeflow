import { Body, Controller, Get, Headers, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { requireIdempotencyKey } from "./required-idempotency-key";
import { CounterSaleDto } from "./counter-sale.dto";
import { CounterSaleService } from "./counter-sale.service";

/**
 * POST /orders/counter-sale — staff ring up an over-the-counter (PICKUP) sale: order + invoice +
 * payment in one call. OPERATOR admits TENANT_ADMIN through RolesGuard's hierarchy. The
 * `Idempotency-Key` header is REQUIRED (400 IDEMPOTENCY_KEY_REQUIRED), same character rules as POST /orders.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class CounterSaleController {
  constructor(private readonly counterSale: CounterSaleService) {}

  /** REQUIRED Idempotency-Key: the one shared normaliser (required-idempotency-key.ts). */
  private normalizeKey(raw: string | undefined): string {
    return requireIdempotencyKey(raw, "ring a counter sale");
  }

  /**
   * A DEFINITIVE answer about a key (the unknown-outcome rule of the till): the sale this key rang, read back
   * from storage with `replayed: true`, or 404 COUNTER_SALE_NOT_FOUND. NOT gated by the counter capability
   * (an answer must be possible even if the gate flipped off) and writes nothing.
   */
  @Get("counter-sale/by-key/:key")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async byKey(@Param("key") rawKey: string) {
    return this.counterSale.byKey(this.normalizeKey(rawKey));
  }

  @Post("counter-sale")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  @ApiHeader({ name: "Idempotency-Key", required: true })
  async ring(
    @Body() dto: CounterSaleDto,
    @CurrentUser() user: JwtPayload,
    @Headers("Idempotency-Key") rawKey?: string,
  ) {
    return this.counterSale.ring(dto, user, this.normalizeKey(rawKey));
  }
}
