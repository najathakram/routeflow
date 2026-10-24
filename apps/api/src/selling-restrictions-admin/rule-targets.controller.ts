import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AddRuleTargetsDto, RemoveRuleTargetsDto, RulesHoldingDto } from "./dto/rule-targets.dto";
import { RuleTargetsService } from "./rule-targets.service";

/**
 * Row 509: a rule's targets. Registered BEFORE `SellingRestrictionsAdminController` in the module so no route there
 * can shadow these (the literal `holding` is one segment like `bulk` / `lift-batch`; `:id` routes are GET and
 * `:id/targets…` POSTs, none of which the admin controller declares). OPERATOR and TENANT_ADMIN; an all-customer rule
 * is TENANT_ADMIN-only for add/remove (checked in the service through `assertMayManageRule`). CUSTOMER, DRIVER and
 * buyer tokens get 403.
 */
@ApiTags("selling-restrictions")
@ApiBearerAuth()
@Controller("selling-restrictions")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RuleTargetsController {
  constructor(private readonly targets: RuleTargetsService) {}

  @Post("holding")
  @Roles(UserRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "The ACTIVE / SCHEDULED rules that hold at least one of these products as a direct target, with how many each holds (catalog 'Remove from a rule')",
  })
  @ApiBody({ type: RulesHoldingDto })
  holding(@Body() dto: RulesHoldingDto) {
    return this.targets.holding(dto);
  }

  @Get(":id")
  @Roles(UserRole.OPERATOR)
  @ApiOperation({ summary: "One rule with its active targets (keyset-paged) and target history" })
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor of the previous page" })
  detail(@Param("id") id: string, @Query("cursor") cursor?: string) {
    return this.targets.detail(id, cursor);
  }

  @Post(":id/targets")
  @Roles(UserRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Add products and/or labels to a rule (up to 1,000 per call, 5,000 per rule); ids already in are skipped and reported",
  })
  @ApiBody({ type: AddRuleTargetsDto })
  add(@Param("id") id: string, @Body() dto: AddRuleTargetsDto, @CurrentUser() user: JwtPayload) {
    return this.targets.addTargets(id, dto, user);
  }

  @Post(":id/targets/remove")
  @Roles(UserRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Remove products and/or labels from a rule (history is kept); removing the last target is 409 RULE_NEEDS_A_TARGET",
  })
  @ApiBody({ type: RemoveRuleTargetsDto })
  remove(
    @Param("id") id: string,
    @Body() dto: RemoveRuleTargetsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.targets.removeTargets(id, dto, user);
  }
}
