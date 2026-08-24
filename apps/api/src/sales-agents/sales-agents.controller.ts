import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { CommissionAccrualStatus, SalesAgentStatus, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { MAX_LIST_LIMIT } from "../common/pagination";
import { SalesAgentsService } from "./sales-agents.service";

// ─── DTOs ────────────────────────────────────────────────────────────────────
// House convention keeps request DTOs in their own dto/*.ts file (see
// create-customer.dto.ts). This work package's file allowlist has no dto/
// path for sales-agents, so its DTOs are declared inline here instead —
// flagged in the PR-C WP5 handoff for a follow-up split if desired.

export class ListSalesAgentsDto {
  @IsOptional() @IsEnum(SalesAgentStatus) status?: SalesAgentStatus;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() includeDeleted?: boolean;
}

export class CreateSalesAgentDto {
  @IsString() @MaxLength(200) name: string;
  @IsOptional() @IsEmail() @MaxLength(254) email?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) defaultRatePct?: number;
  @IsOptional() @IsDateString() rateEffectiveFrom?: string;
}

export class UpdateSalesAgentDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  // `null` clears the email — @IsOptional() skips validation for null/undefined,
  // so only a non-empty value is checked against @IsEmail().
  @IsOptional() @IsEmail() @MaxLength(254) email?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class UpdateSalesAgentStatusDto {
  @IsEnum(SalesAgentStatus) status: SalesAgentStatus;
  // Only meaningful entering STOPPED_FOR_NEW; defaults to now when omitted.
  @IsOptional() @IsDateString() stopNewBusinessAt?: string;
}

export class AddSalesAgentRateDto {
  @IsNumber() @Min(0) @Max(100) ratePct: number;
  @IsDateString() effectiveFrom: string;
}

export class AddCustomerCommissionRateDto {
  @IsUUID() customerId: string;
  @IsNumber() @Min(0) @Max(100) ratePct: number;
  @IsDateString() effectiveFrom: string;
}

export class AddAgentAssignmentDto {
  @IsUUID() customerId: string;
  @IsOptional() @IsDateString() effectiveFrom?: string;
}

export class BulkAgentAssignmentDto {
  @IsArray() @ArrayMaxSize(500) @IsUUID(undefined, { each: true }) customerIds: string[];
  @IsOptional() @IsDateString() effectiveFrom?: string;
}

export class CloseAgentAssignmentDto {
  @IsUUID() customerId: string;
  @IsOptional() @IsDateString() effectiveTo?: string;
}

export class ListCommissionAccrualsDto {
  @IsOptional() @IsEnum(CommissionAccrualStatus) status?: CommissionAccrualStatus;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_LIST_LIMIT) limit?: number;
}

export class RecomputeCommissionsDto {
  @IsDateString() fromDate: string;
}

export class CurrentAssignmentQueryDto {
  @IsUUID() customerId: string;
}

// ─── Controller ────────────────────────────────────────────────────────────

/**
 * Sales agent records: agents, their default + per-customer rates, customer
 * attribution (assignments), and the accrual ledger. Records-only v1 — no
 * agent login, no new UserRole (owner decision). Class-gated on
 * flag.sales_agents: the whole surface 403s with a PLAN_GATE body when the
 * tenant lacks the addon (guard reads class-level metadata via
 * getAllAndOverride, so one @RequirePlanFlag here covers every route).
 */
@Controller("sales-agents")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@Roles(UserRole.OPERATOR)
@RequirePlanFlag("flag.sales_agents")
export class SalesAgentsController {
  constructor(private readonly salesAgentsService: SalesAgentsService) {}

  @Get()
  findAll(@Query() query: ListSalesAgentsDto) {
    return this.salesAgentsService.findAll(query);
  }

  @Post()
  create(@Body() dto: CreateSalesAgentDto) {
    return this.salesAgentsService.create(dto);
  }

  // Two-segment route — cannot collide with the one-segment ":id" routes below
  // regardless of declaration order, but grouped near the other assignment
  // routes for readability.
  @Post("assignments/close")
  closeAssignment(@Body() dto: CloseAgentAssignmentDto) {
    return this.salesAgentsService.closeAssignment(dto);
  }

  @Get("assignments/current")
  currentAssignment(@Query() query: CurrentAssignmentQueryDto) {
    return this.salesAgentsService.currentAssignment(query.customerId);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.salesAgentsService.findOne(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateSalesAgentDto) {
    return this.salesAgentsService.update(id, dto);
  }

  @Patch(":id/status")
  updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateSalesAgentStatusDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.salesAgentsService.updateStatus(id, dto, user);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.salesAgentsService.remove(id);
  }

  @Post(":id/rates")
  addRate(@Param("id") id: string, @Body() dto: AddSalesAgentRateDto) {
    return this.salesAgentsService.addRate(id, dto);
  }

  @Delete(":id/rates/:rateId")
  removeRate(@Param("id") id: string, @Param("rateId") rateId: string) {
    return this.salesAgentsService.removeRate(id, rateId);
  }

  @Post(":id/customer-rates")
  addCustomerRate(@Param("id") id: string, @Body() dto: AddCustomerCommissionRateDto) {
    return this.salesAgentsService.addCustomerRate(id, dto);
  }

  @Post(":id/assignments")
  addAssignment(@Param("id") id: string, @Body() dto: AddAgentAssignmentDto) {
    return this.salesAgentsService.addAssignment(id, dto);
  }

  @Post(":id/assignments/bulk")
  addAssignmentsBulk(@Param("id") id: string, @Body() dto: BulkAgentAssignmentDto) {
    return this.salesAgentsService.addAssignmentsBulk(id, dto);
  }

  @Get(":id/accruals")
  getAccruals(@Param("id") id: string, @Query() query: ListCommissionAccrualsDto) {
    return this.salesAgentsService.getAccruals(id, query);
  }

  @Post(":id/recompute")
  recompute(@Param("id") id: string, @Body() dto: RecomputeCommissionsDto) {
    return this.salesAgentsService.recompute(id, dto);
  }
}
