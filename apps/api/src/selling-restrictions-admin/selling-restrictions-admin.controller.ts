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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
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
import { BULK_RESTRICTION_MAX, BulkRestrictionDto } from "./dto/bulk-restriction.dto";

const STATUSES = Object.fromEntries(RESTRICTION_STATUSES.map((s) => [s, s]));

// Reads: OPERATOR. Writes: OPERATOR too (owner 10-07: operators are near-admins); TENANT_ADMIN
// satisfies OPERATOR in RolesGuard. CUSTOMER, DRIVER and buyer tokens are refused (403).
@ApiTags("selling-restrictions")
@ApiBearerAuth()
@Controller("selling-restrictions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class SellingRestrictionsAdminController {
  constructor(private readonly rules: SellingRestrictionsAdminService) {}

  @Get()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "List selling restrictions (rules), optionally by status" })
  list(
    @Query("status", new ParseEnumPipe(STATUSES, { optional: true })) status?: RestrictionStatus,
  ) {
    return this.rules.list(status);
  }

  @Post()
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "Create one selling restriction for a category or a product (audited)" })
  @ApiBody({ type: CreateRestrictionDto })
  create(@Body() dto: CreateRestrictionDto, @CurrentUser() user: JwtPayload) {
    return this.rules.create(dto, user);
  }

  @Post("bulk")
  @Roles(UserRole.OPERATOR)
  @ApiOperation({
    summary: `Limit up to ${BULK_RESTRICTION_MAX} products, or one category, in the portal in one transaction (audited once); identical live rules are skipped`,
  })
  @ApiBody({ type: BulkRestrictionDto })
  bulkCreate(@Body() dto: BulkRestrictionDto, @CurrentUser() user: JwtPayload) {
    return this.rules.bulkCreate(dto, user);
  }

  @Post(":id/lift")
  @Roles(UserRole.TENANT_ADMIN)
  lift(@Param("id") id: string, @Body() dto: LiftRestrictionDto, @CurrentUser() user: JwtPayload) {
    return this.rules.lift(id, dto, user);
  }
}
