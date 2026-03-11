import { IsDateString, IsOptional, IsString } from "class-validator";

export class CreateRouteRunDto {
  @IsString() routeId: string;
  @IsDateString() scheduledDate: string;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsString() notes?: string;
}
