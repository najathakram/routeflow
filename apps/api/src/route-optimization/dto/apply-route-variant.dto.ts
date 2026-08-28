import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString } from "class-validator";

/**
 * Body of `POST /routes/:id/variants/apply` — the variant the user picked in
 * the comparison UI. `stopIds` must be an exact permutation of the route's
 * current stops (enforced in the service, which knows the stop set).
 */
export class ApplyRouteVariantDto {
  /** Which candidate config produced this order — display/telemetry only. */
  @IsOptional() @IsString() key?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  stopIds!: string[];

  @IsIn(["TIME", "DISTANCE"]) optimizeBy!: "TIME" | "DISTANCE";

  @IsBoolean() avoidTolls!: boolean;

  /** The variant's encoded road polyline; omitted/null clears the stored one. */
  @IsOptional() @IsString() encodedPolyline?: string | null;

  /**
   * When given, the SCHEDULED run to re-number in the same transaction so the
   * visible run order matches the chosen route immediately. Omit to persist
   * onto the route template only (applies to that route's future runs).
   */
  @IsOptional() @IsString() runId?: string;
}
