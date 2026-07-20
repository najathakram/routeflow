import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type, Transform } from "class-transformer";

export class ListSuppliersDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isActive?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  // 0 = fetch-all sentinel — the service maps it to a capped fetch (findAll's
  // `fetchAll = limitRaw === 0`) and the web Suppliers page relies on it. The
  // F9 pagination hardening set @Min(1) and silently 400'd that page ("Failed
  // to load data. Please try refreshing."); paged requests stay capped at 200.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(200) limit?: number;
}
