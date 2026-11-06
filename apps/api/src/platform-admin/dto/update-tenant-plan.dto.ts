import { IsIn, IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";
import { TenantPlan } from "@prisma/client";
import { SELECTABLE_TENANT_PLANS } from "../../billing/plan-catalog.constants";

/** R49: the shortest and longest reason an admin may give for moving a business to another plan. */
export const PLAN_MOVE_REASON_MIN = 3;
export const PLAN_MOVE_REASON_MAX = 500;

export class UpdateTenantPlanDto {
  // GROWTH/SCALE are selectable here as of Phase 0 Task 10 — see SELECTABLE_TENANT_PLANS in
  // plan-catalog.constants.ts.
  @ApiProperty({ enum: SELECTABLE_TENANT_PLANS })
  @IsIn(SELECTABLE_TENANT_PLANS)
  plan: TenantPlan;

  /** R49: why this business is moving; written into the plan-change audit row. */
  @ApiProperty({
    description: "Why this business is moving to another plan (3 to 500 characters).",
    minLength: PLAN_MOVE_REASON_MIN,
    maxLength: PLAN_MOVE_REASON_MAX,
  })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(PLAN_MOVE_REASON_MIN)
  @MaxLength(PLAN_MOVE_REASON_MAX)
  reason: string;
}
