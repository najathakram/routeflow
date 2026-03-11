import { IsOptional, IsString } from "class-validator";

export class UpdateDriverDto {
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() vehicleMake?: string;
  @IsOptional() @IsString() vehicleModel?: string;
  @IsOptional() @IsString() vehicleColour?: string;
  @IsOptional() @IsString() vehiclePlate?: string;
}
