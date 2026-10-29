import { IsIn, IsISO8601, IsObject, IsOptional, IsString } from "class-validator";

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

  /**
   * PATCH only (SA-817 A2): the `updatedAt` the client last saw. A different current value is a 409 `DRAFT_CHANGED`. Omitted =
   * last write wins (older clients). Ignored on create.
   */
  @IsOptional()
  @IsISO8601()
  expectedUpdatedAt?: string;
}
