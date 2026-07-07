import { IsOptional, IsString } from "class-validator";

export class ListLedgerDto {
  /** Filter to one tracked category id. */
  @IsOptional() @IsString() category?: string;
  /** ISO date — sales on/after this. */
  @IsOptional() @IsString() from?: string;
  /** ISO date — sales on/before this. */
  @IsOptional() @IsString() to?: string;
}
