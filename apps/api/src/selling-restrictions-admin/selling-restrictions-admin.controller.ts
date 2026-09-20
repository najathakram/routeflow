import { Controller, Get, ParseEnumPipe, Query, UseGuards } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { RestrictionStatus } from "@routeflow/types";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";

const STATUSES = {
  ACTIVE: "ACTIVE",
  SCHEDULED: "SCHEDULED",
  EXPIRED: "EXPIRED",
  LIFTED: "LIFTED",
} as const;

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
}
