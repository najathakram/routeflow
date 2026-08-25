import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Type, Transform } from "class-transformer";
import { RouteKind } from "@prisma/client";

export class ListRoutesDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
  // Defaults to SCHEDULED in RoutesService.findAllRoutes when omitted, so ADHOC
  // trips never pollute the templates list.
  @IsOptional() @IsEnum(RouteKind) kind?: RouteKind;
}
