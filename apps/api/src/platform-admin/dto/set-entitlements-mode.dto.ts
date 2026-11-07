import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class SetEntitlementsModeDto {
  // Local literal array on purpose (L-151): API source never value-imports @routeflow/types.
  @IsIn(["shadow", "live"] as const)
  mode!: "shadow" | "live";

  /** Kept for the audit entry only; it opens nothing. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
