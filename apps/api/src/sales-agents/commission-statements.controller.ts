import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { CommissionStatementStatus, PaymentMethod, UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { RequirePlanFlag } from "../billing/require-plan-flag.decorator";
import { CommissionStatementsService } from "./commission-statements.service";

// ─── DTOs ────────────────────────────────────────────────────────────────────
// See the note in sales-agents.controller.ts: house convention is a
// dto/*.ts file; this package's file allowlist has no dto/ path for
// sales-agents, so its DTOs are declared inline here instead.

export class ListCommissionStatementsDto {
  @IsOptional() @IsUUID() agentId?: string;
  @IsOptional() @IsEnum(CommissionStatementStatus) status?: CommissionStatementStatus;
}

export class GenerateCommissionStatementDto {
  @IsUUID() agentId: string;
  @IsOptional() @IsDateString() periodFrom?: string;
  @IsOptional() @IsDateString() periodTo?: string;
}

export class RecordCommissionPayoutDto {
  @IsNumber() @IsPositive() amount: number;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() @MaxLength(120) reference?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsDateString() paidAt?: string;
}

// ─── Controller ────────────────────────────────────────────────────────────

/**
 * Commission statements: generate (claim unclaimed payable + sweep
 * adjustments/carryforwards) → approve (re-validates live drift, 409s on
 * staleness) → payouts (capped by ledger-derived remaining, books a linked
 * COMMISSIONS_AND_FEES Expense). Class-gated on flag.sales_agents.
 */
@Controller("commission-statements")
@UseGuards(JwtAuthGuard, RolesGuard, PlanFlagGuard)
@Roles(UserRole.OPERATOR)
@RequirePlanFlag("flag.sales_agents")
export class CommissionStatementsController {
  constructor(private readonly statementsService: CommissionStatementsService) {}

  @Get()
  findAll(@Query() query: ListCommissionStatementsDto) {
    return this.statementsService.findAll(query);
  }

  @Post("generate")
  generate(@Body() dto: GenerateCommissionStatementDto) {
    return this.statementsService.generate(dto);
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return this.statementsService.findOne(id);
  }

  @Post(":id/approve")
  approve(@Param("id") id: string) {
    return this.statementsService.approve(id);
  }

  @Post(":id/void")
  voidStatement(@Param("id") id: string) {
    return this.statementsService.voidStatement(id);
  }

  @Post(":id/payouts")
  recordPayout(@Param("id") id: string, @Body() dto: RecordCommissionPayoutDto) {
    return this.statementsService.recordPayout(id, dto);
  }

  @Get(":id/payouts")
  listPayouts(@Param("id") id: string) {
    return this.statementsService.listPayouts(id);
  }
}
