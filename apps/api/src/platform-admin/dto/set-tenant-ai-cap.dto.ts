import { IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * `PATCH /platform-admin/tenants/:id/ai-cap` body. Three states: a whole number of USD sets this business's monthly AI
 * allowance on RouteFlow's key (0 = AI off), `null` clears the override so the platform `ai.monthlyCapUsd` applies
 * again, and an absent key leaves it alone.
 */
export class SetTenantAiCapDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  aiMonthlyCapUsd?: number | null;
}
