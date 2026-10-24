import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { CounterSaleVoidDto } from "./counter-sale-void.dto";
import { CounterSaleVoidService } from "./counter-sale-void.service";

/**
 * POST /orders/counter-sale/:orderId/void (SA-762r): void a counter sale rung today: its counter tender, invoices and
 * order in one transaction (counter-sale-void.service.ts). 200 either way: a repeat answers `replayed: true` with the
 * same `handBack`. The role gate is OPERATOR (admits TENANT_ADMIN and SUPER_ADMIN); the capability (staffMay
 * VOID_SALE) is judged again in the service. Its own controller so the register's controller keeps its shape; the
 * path has two segments after `counter-sale`, so no `orders/:id` route can take it.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class CounterSaleVoidController {
  constructor(private readonly voids: CounterSaleVoidService) {}

  @Post("counter-sale/:orderId/void")
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async voidSale(
    @Param("orderId", ParseUUIDPipe) orderId: string,
    @Body() dto: CounterSaleVoidDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.voids.voidSale(orderId, dto, user);
  }
}
