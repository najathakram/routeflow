import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { UserStatus } from "@prisma/client";
import { MAX_LIST_LIMIT } from "../../common/pagination";

export class ListCustomersDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_LIST_LIMIT) limit?: number;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() customerType?: string;
  /** "1" = only customers authorized to sell regulated items (see customers.service.findAll). */
  @IsOptional() @IsString() regulated?: string;
  /** "1" = only customers with no stop on a currently SCHEDULED route (REG-B156). */
  @IsOptional() @IsString() unassigned?: string;
  /** "1" = only soft-deleted (removed) customers — an explicit trash view (REG-B170). */
  @IsOptional() @IsString() removed?: string;
  @IsOptional() @IsString() sortBy?: string;
  @IsOptional() @IsString() sortDir?: string;
}
