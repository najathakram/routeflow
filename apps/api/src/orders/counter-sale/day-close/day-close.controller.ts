import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../../auth/guards/roles.guard";
import { TillPermissionGuard } from "../till-permission.guard";
import { Roles } from "../../../auth/decorators/roles.decorator";
import { CurrentUser } from "../../../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../../../auth/jwt-payload.interface";
import { DayCloseDto, DayCloseQueryDto } from "./day-close.dto";
import { CounterDayCloseService } from "./day-close.service";

/**
 * Counter DAY CLOSE + Z REPORT (SA-750r3). Same `orders` base as the counter-sale controller, two or more segments deep so
 * `GET orders/:id` can never take them. Every route is OPERATOR (RolesGuard admits TENANT_ADMIN through the hierarchy, which is
 * exactly "OPERATOR or TENANT_ADMIN" for reopen and the report resend) and is refused COUNTER_SALES_DISABLED by the service for a
 * tenant with counter sales off.
 */
@ApiTags("orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("orders")
export class CounterDayCloseController {
  constructor(private readonly dayClose: CounterDayCloseService) {}

  /** The state: the last close, the sales since, and the live preview of the window the next close covers. */
  @Get("counter-sale/day-close")
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  state(@Query() query: DayCloseQueryDto) {
    return this.dayClose.state(query.registerKey);
  }

  /** The latest close of the register (404 when none): "Last close · View". Declared before `:id` so it is never read as one. */
  @Get("counter-sale/day-close/latest")
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  latest(@Query() query: DayCloseQueryDto) {
    return this.dayClose.latestClose(query.registerKey);
  }

  /** One past close by id. */
  @Get("counter-sale/day-close/:id")
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  byId(@Param("id", ParseUUIDPipe) id: string) {
    return this.dayClose.closeById(id);
  }

  /** Closes the window (or re-closes a reopened one). The server recomputes every figure. */
  @Post("counter-sale/day-close")
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  close(@Body() dto: DayCloseDto, @CurrentUser() user: JwtPayload) {
    return this.dayClose.close(dto, user);
  }

  /** Reopens the latest close of its till (audited). */
  @Post("counter-sale/day-close/:id/reopen")
  @HttpCode(200)
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  reopen(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.dayClose.reopen(id, user);
  }

  /** Sends the Z report again. */
  @Post("counter-sale/day-close/:id/report")
  @HttpCode(200)
  @UseGuards(RolesGuard, TillPermissionGuard)
  @Roles(UserRole.OPERATOR)
  report(@Param("id", ParseUUIDPipe) id: string) {
    return this.dayClose.resendReport(id);
  }
}
