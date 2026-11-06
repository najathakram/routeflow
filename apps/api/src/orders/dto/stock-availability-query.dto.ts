import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

/** SA-1086: `GET /orders/stock-availability?productIds=a,b&mode=entry|edit&customerId=` (comma list, at most 200 ids read). */
export class StockAvailabilityQueryDto {
  @IsOptional() @IsString() @MaxLength(20_000) productIds?: string;
  @IsOptional() @IsIn(["entry", "edit"]) mode?: "entry" | "edit";
  @IsOptional() @IsString() customerId?: string;
}
