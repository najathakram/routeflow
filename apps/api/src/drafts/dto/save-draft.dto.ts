import { IsIn, IsObject, IsOptional, IsString } from "class-validator";

/**
 * Create/update a parked builder draft (pos-cost-roles-spec §2). `payload` is the
 * full builder state so a draft restores exactly on resume.
 */
export class SaveDraftDto {
  @IsOptional()
  @IsIn(["ORDER", "INVOICE"])
  kind?: "ORDER" | "INVOICE";

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  device?: string;
}
