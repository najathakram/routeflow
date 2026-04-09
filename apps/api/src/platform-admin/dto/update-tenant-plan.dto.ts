import { IsEnum } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { TenantPlan } from "@prisma/client";

export class UpdateTenantPlanDto {
  @ApiProperty({ enum: TenantPlan })
  @IsEnum(TenantPlan)
  plan: TenantPlan;
}
