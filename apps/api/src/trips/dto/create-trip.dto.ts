import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { TripEndDto } from "./route-planning.dto";

export enum TripOriginType {
  TENANT = "TENANT",
  DRIVER = "DRIVER",
  ADDRESS = "ADDRESS",
}

export class TripOriginDto {
  @IsEnum(TripOriginType)
  type!: TripOriginType;

  @ValidateIf((o) => o.type === TripOriginType.DRIVER)
  @IsString()
  @IsNotEmpty()
  driverId?: string;

  @ValidateIf((o) => o.type === TripOriginType.ADDRESS)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  line1?: string;

  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(50) state?: string;
  @IsOptional() @IsString() @MaxLength(20) zip?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
}

export class CreateTripDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  orderIds!: string[];

  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() driverId?: string;

  @ValidateNested()
  @Type(() => TripOriginDto)
  origin!: TripOriginDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => TripEndDto)
  end?: TripEndDto;

  @IsOptional() @IsBoolean() avoidTolls?: boolean;
  @IsOptional() @IsIn(["TIME", "DISTANCE"]) optimizeBy?: "TIME" | "DISTANCE";
}
