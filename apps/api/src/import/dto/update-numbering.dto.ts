import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/** Body for `PUT /import/numbering/:docType` — all fields optional (partial edit). */
export class UpdateNumberingDto {
  @IsOptional()
  @IsString()
  @MaxLength(16)
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  // 9 digits: the numbering scans capture \d{1,9} (an int cast), so a larger next number would
  // be invisible to the max-first guard and the save check (SA-274 invariant).
  @Max(999_999_999)
  nextNumber?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  padding?: number;

  /**
   * Optimistic-concurrency token (SA-274 Q3): the stored `nextNumber` the web
   * card loaded before editing. When present, the server compare-and-sets
   * against it and 409s (numbering changed since the card was opened) instead
   * of silently overwriting a save that landed in between. Omit it to keep
   * today's unconditional upsert (seeding from a migration source).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_000_000_000)
  expectedNextNumber?: number;
}
