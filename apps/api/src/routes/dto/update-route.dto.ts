import { IsBoolean, IsOptional, IsString } from "class-validator";

export class UpdateRouteDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
