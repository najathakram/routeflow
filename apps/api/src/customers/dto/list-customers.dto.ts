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
  @IsOptional() @IsString() sortBy?: string;
  @IsOptional() @IsString() sortDir?: string;
}
