import { IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateDriverDto {
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() vehicleMake?: string;
  @IsOptional() @IsString() vehicleModel?: string;
  @IsOptional() @IsString() vehicleColour?: string;
  @IsOptional() @IsString() vehiclePlate?: string;

  // Driver home base — best-effort geocoded on save (see DriversService.update) so
  // trips can resolve an origin for a driver not tied to a route/warehouse.
  @IsOptional() @IsString() @MaxLength(200) homeLine1?: string;
  @IsOptional() @IsString() @MaxLength(100) homeCity?: string;
  @IsOptional() @IsString() @MaxLength(50) homeState?: string;
  @IsOptional() @IsString() @MaxLength(20) homeZip?: string;
}
