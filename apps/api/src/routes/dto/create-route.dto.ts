import { IsOptional, IsString } from "class-validator";

export class CreateRouteDto {
  @IsString() name: string;
  @IsOptional() @IsString() driverId?: string;
}
