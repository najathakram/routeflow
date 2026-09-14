import { IsIn } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { TenantPlan } from "@prisma/client";
import { SELECTABLE_TENANT_PLANS } from "../../billing/plan-catalog.constants";

export class UpdateTenantPlanDto {
  // GROWTH/SCALE are valid TenantPlan enum members but not yet selectable here — see
  // SELECTABLE_TENANT_PLANS in plan-catalog.constants.ts (Phase 0 Task 10 gap).
  @ApiProperty({ enum: SELECTABLE_TENANT_PLANS })
  @IsIn(SELECTABLE_TENANT_PLANS)
  plan: TenantPlan;
}
