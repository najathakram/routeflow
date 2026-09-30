import { IsIn } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { TenantPlan } from "@prisma/client";
import { SELECTABLE_TENANT_PLANS } from "../../billing/plan-catalog.constants";

export class UpdateTenantPlanDto {
  // GROWTH/SCALE are selectable here as of Phase 0 Task 10 — see SELECTABLE_TENANT_PLANS in
  // plan-catalog.constants.ts.
  @ApiProperty({ enum: SELECTABLE_TENANT_PLANS })
  @IsIn(SELECTABLE_TENANT_PLANS)
  plan: TenantPlan;
}
