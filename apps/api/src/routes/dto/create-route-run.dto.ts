import { IsDateString, IsOptional, IsString, Matches } from "class-validator";

export class CreateRouteRunDto {
  @IsString() routeId: string;
  @IsDateString() scheduledDate: string;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsString() @Matches(/^\d{2}:\d{2}$/) startTime?: string;
  @IsOptional() @IsString() notes?: string;
}
