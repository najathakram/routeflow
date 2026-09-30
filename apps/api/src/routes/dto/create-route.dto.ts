import { Type } from "class-transformer";
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import { TripOriginDto } from "../../trips/dto/create-trip.dto";
import { TripEndDto } from "../../trips/dto/route-planning.dto";

export class CreateRouteDto {
  @IsString() name: string;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsNumber() depotLat?: number;
  @IsOptional() @IsNumber() depotLng?: number;
  @IsOptional() @IsString() depotAddress?: string;

  // ─── Route planning (start/end points, tolls, objective) ──────────────────
  // Additive/optional: legacy callers that only send name/driverId/depot*
  // keep working unchanged. `origin`/`end` reuse the trip builder's DTOs
  // (apps/api/src/trips/dto/*) so the two builders validate identically —
  // see RoutesService.resolveRouteOrigin/resolveRouteEnd for the TENANT
  // short-circuit (resolved client-side, unlike DRIVER/ADDRESS).
  @IsOptional() @ValidateNested() @Type(() => TripOriginDto) origin?: TripOriginDto;
  @IsOptional() @ValidateNested() @Type(() => TripEndDto) end?: TripEndDto;
  @IsOptional() @IsBoolean() avoidTolls?: boolean;
  @IsOptional() @IsIn(["TIME", "DISTANCE"]) optimizeBy?: "TIME" | "DISTANCE";
}
