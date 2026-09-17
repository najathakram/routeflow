import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class SetEntitlementsModeDto {
  // Local literal array on purpose (L-151): API source never value-imports @routeflow/types.
  @IsIn(["shadow", "live"] as const)
  mode!: "shadow" | "live";

  /** Required alongside `force: true` to switch to `live` while unexplained diffs exist. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
