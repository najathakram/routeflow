import { IsBoolean, IsNumber, IsOptional, IsString } from "class-validator";

export class UpdateRouteDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsNumber() depotLat?: number;
  @IsOptional() @IsNumber() depotLng?: number;
  @IsOptional() @IsString() depotAddress?: string;
}
