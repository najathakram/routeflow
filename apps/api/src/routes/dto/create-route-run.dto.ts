import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";

export class CreateRouteRunDto {
  @IsString() routeId: string;
  @IsDateString() scheduledDate: string;
  @IsOptional() @IsString() driverId?: string;
  @IsOptional() @IsString() @Matches(/^\d{2}:\d{2}$/) startTime?: string;
  @IsOptional() @IsString() notes?: string;

  // ADHOC dispatch only — narrows the dispatch sweep to exactly these orders.
  // Rejected with 400 in routes.service.createRun when the target route isn't
  // Route.kind ADHOC (see the guard there).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  orderIds?: string[];
}
