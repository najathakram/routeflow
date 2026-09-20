import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { RestrictionStatus } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import {
  RESTRICTION_STATUSES,
  SellingRestrictionsAdminService,
} from "./selling-restrictions-admin.service";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { CreateRestrictionDto } from "./dto/create-restriction.dto";
import { LiftRestrictionDto } from "./dto/lift-restriction.dto";

const STATUSES = Object.fromEntries(RESTRICTION_STATUSES.map((s) => [s, s]));

// Reads: OPERATOR. Writes: TENANT_ADMIN only (owner ruling, Lane R) — a rule decides what may be sold.
@Controller("selling-restrictions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SellingRestrictionsAdminController {
  constructor(private readonly rules: SellingRestrictionsAdminService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  list(
    @Query("status", new ParseEnumPipe(STATUSES, { optional: true })) status?: RestrictionStatus,
  ) {
    return this.rules.list(status);
  }

  @Post()
  @Roles(UserRole.TENANT_ADMIN)
  create(@Body() dto: CreateRestrictionDto, @CurrentUser() user: JwtPayload) {
    return this.rules.create(dto, user);
  }

  @Post(":id/lift")
  @Roles(UserRole.TENANT_ADMIN)
  lift(@Param("id") id: string, @Body() dto: LiftRestrictionDto, @CurrentUser() user: JwtPayload) {
    return this.rules.lift(id, dto, user);
  }
}
