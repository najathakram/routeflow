import { BadRequestException, Body, Controller, Headers, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiHeader, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { CounterSaleDto } from "./counter-sale.dto";
import { CounterSaleService } from "./counter-sale.service";

/**
 * POST /orders/counter-sale — staff ring up an over-the-counter (PICKUP) sale: order + invoice +
 * payment in one call. OPERATOR admits TENANT_ADMIN through RolesGuard's hierarchy. Same
 * `Idempotency-Key` header, same normaliser rules as POST /orders.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class CounterSaleController {
  constructor(private readonly counterSale: CounterSaleService) {}

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

  @Post("counter-sale")
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  @ApiHeader({ name: "Idempotency-Key", required: false })
  async ring(
    @Body() dto: CounterSaleDto,
    @CurrentUser() user: JwtPayload,
    @Headers("Idempotency-Key") rawKey?: string,
  ) {
    return this.counterSale.ring(dto, user, this.normalizeKey(rawKey));
  }
}
