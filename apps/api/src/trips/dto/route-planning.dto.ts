import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { TripOriginDto } from "./create-trip.dto";

export enum TripEndType {
  NONE = "NONE",
  RETURN_TO_START = "RETURN_TO_START",
  DRIVER_HOME = "DRIVER_HOME",
  ADDRESS = "ADDRESS",
}

export class TripEndDto {
  @IsEnum(TripEndType)
  type!: TripEndType;

  // Length caps mirror TripOriginDto's exactly — the same address fields, at
  // the other end of the trip, land in the same columns.
  @IsOptional() @IsString() driverId?: string; // DRIVER_HOME; defaults to the route's driver
  @IsOptional() @IsString() @MaxLength(200) line1?: string; // ADDRESS
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(50) state?: string;
  @IsOptional() @IsString() @MaxLength(20) zip?: string;
}

export class RoutePlanningDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => TripOriginDto)
  origin?: TripOriginDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TripEndDto)
  end?: TripEndDto;

  @IsOptional() @IsBoolean() avoidTolls?: boolean;
  @IsOptional() @IsIn(["TIME", "DISTANCE"]) optimizeBy?: "TIME" | "DISTANCE";
}
