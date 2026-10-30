import { Body, Controller, Get, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../../auth/guards/roles.guard";
import { Roles } from "../../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { TillPermissionGuard } from "../till-permission.guard";
import {
  CorrectOpeningFloatDto,
  OpeningFloatQueryDto,
  RecordOpeningFloatDto,
} from "./counter-drawer.dto";
import { CounterDrawerService } from "./counter-drawer.service";

/**
 * Counter DRAWER events (W-819 part 1, SA-930 section 4). Same `orders` base as the day close, three segments deep so
 * `GET orders/:id` can never take them. Record and read: OPERATOR behind the till guard (TENANT_ADMIN passes through the role
 * hierarchy). Correct: TENANT_ADMIN only (the till guard is on it too: the census pins every counter handler, and an admin always passes it).
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class CounterDrawerController {
  constructor(private readonly drawer: CounterDrawerService) {}

  @Get("counter-sale/drawer/opening-float")
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  read(@Query() q: OpeningFloatQueryDto) {
    return this.drawer.read(q.registerKey, q.windowStart);
  }

  @Post("counter-sale/drawer/opening-float")
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  record(@Body() dto: RecordOpeningFloatDto, @CurrentUser() user: JwtPayload) {
    return this.drawer.record(dto, user);
  }

  @Patch("counter-sale/drawer/opening-float")
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.TENANT_ADMIN)
  correct(@Body() dto: CorrectOpeningFloatDto, @CurrentUser() user: JwtPayload) {
    return this.drawer.correct(dto, user);
  }
}
