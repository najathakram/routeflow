import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Transform, Type } from "class-transformer";
import { RouteRunStatus } from "@prisma/client";

export class ListRunsDto {
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() assignedToMe?: boolean;
  @IsOptional() @IsEnum(RouteRunStatus) status?: RouteRunStatus;
  // When true, returns only runs with status SCHEDULED or IN_PROGRESS — i.e.
  // the same statuses the dispatch endpoint considers "active" when blocking a
  // duplicate dispatch. Used by the operator routes page so stale active runs
  // from previous days are visible (without this, an orphan SCHEDULED run from
  // yesterday is invisible to the operator yet still blocks today's dispatch).
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() activeOnly?: boolean;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) limit?: number = 20;
}
