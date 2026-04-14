import { IsNumber, IsOptional, IsString } from "class-validator";

export class CreateRouteDto {
  @IsString() name: string;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsNumber() depotLat?: number;
  @IsOptional() @IsNumber() depotLng?: number;
  @IsOptional() @IsString() depotAddress?: string;
}
