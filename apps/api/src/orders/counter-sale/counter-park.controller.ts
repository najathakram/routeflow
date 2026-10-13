import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import type {
  ParkCartResponse,
  ParkedCartListResponse,
  ResumeParkedCartResponse,
} from "@routeflow/pricing";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { Roles } from "../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { ListParkedDto, ParkCartDto, ResumeParkedDto } from "./counter-park.dto";
import { CounterParkService } from "./counter-park.service";

/**
 * Parked counter sales (SA-748): `POST|GET /orders/counter-sale/parked`, `POST .../parked/:id/resume`,
 * `DELETE .../parked/:id`. OPERATOR (admits TENANT_ADMIN through RolesGuard's hierarchy), tenant-scoped, every route
 * refused with COUNTER_SALES_DISABLED when the tenant has counter sales off (the service applies the gate first).
 * Registered right after `CounterSaleController` in OrdersModule; every path has the literal `counter-sale/parked`
 * segment, so neither `counter-sale/by-key/:key` nor `orders/:id` can take them (a route-table spec pins it).
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OPERATOR)
@Controller("orders/counter-sale/parked")
export class CounterParkController {
  constructor(private readonly parked: CounterParkService) {}

  /** Park the cart. Idempotent on the client-minted `id`; 409 PARK_LIMIT at 10 open carts on the register. */
  @Post()
  park(@Body() dto: ParkCartDto, @CurrentUser() user: JwtPayload): Promise<ParkCartResponse> {
    return this.parked.park(dto, user);
  }

  /** The register's open parked carts, newest first (never the payload). */
  @Get()
  list(@Query() query: ListParkedDto): Promise<ParkedCartListResponse> {
    return this.parked.list(query);
  }

  /** Take a parked cart back: exactly one caller wins (a retry with the SAME `resumeAttemptId` re-reads it); 404 PARK_TAKEN for everyone else. */
  @Post(":id/resume")
  resume(
    @Param("id") id: string,
    @Body() dto: ResumeParkedDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ResumeParkedCartResponse> {
    return this.parked.resume(id, dto.resumeAttemptId, user);
  }

  /** Discard a parked cart that nobody has resumed: 204, or 404 PARK_TAKEN. */
  @Delete(":id")
  @HttpCode(204)
  async discard(@Param("id") id: string): Promise<void> {
    await this.parked.discard(id);
  }
}
