import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
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
import { BULK_RESTRICTION_MAX, BulkRestrictionDto, LiftBatchDto } from "./dto/bulk-restriction.dto";

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
  @ApiOperation({
    summary:
      "List selling restrictions (rules), optionally by status; with productId, the active rules binding that product (product-page chips: via PRODUCT, PARENT or CATEGORY), keyset-paged",
  })
  @ApiQuery({ name: "status", required: false, enum: RESTRICTION_STATUSES })
  @ApiQuery({ name: "productId", required: false })
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor of the previous page" })
  list(
    @Query("status", new ParseEnumPipe(STATUSES, { optional: true })) status?: RestrictionStatus,
    @Query("productId") productId?: string,
    @Query("cursor") cursor?: string,
  ) {
    if (productId !== undefined) {
      if (typeof productId !== "string" || productId.trim() === "" || productId.length > 64) {
        throw new BadRequestException("productId must be a product id.");
      }
      return this.rules.productLimits(productId, cursor);
    }
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

  @Post("lift-batch")
  @Roles(UserRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: `Lift up to ${BULK_RESTRICTION_MAX} rules in one transaction (audited once); 409 and nothing changed if any is unknown or already lifted`,
  })
  @ApiBody({ type: LiftBatchDto })
  liftBatch(@Body() dto: LiftBatchDto, @CurrentUser() user: JwtPayload) {
    return this.rules.liftBatch(dto, user);
  }

  @Post(":id/lift")
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "Lift one rule now (audited); 409 if it was already lifted" })
  @ApiBody({ type: LiftRestrictionDto })
  lift(@Param("id") id: string, @Body() dto: LiftRestrictionDto, @CurrentUser() user: JwtPayload) {
    return this.rules.lift(id, dto, user);
  }
}
