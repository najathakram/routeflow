import { Transform } from "class-transformer";
import { IsInt, IsString, Max, MaxLength, Min, MinLength } from "class-validator";

/**
 * The operator's answer for a parked regulated-ledger reversal (SA-089/B660): the PACK the
 * sold line was actually packed at, and why. Mirrors `ResolveParkedRestockDto`'s bounds
 * exactly — 1 is a legitimate answer (a line that was never really boxed), never a sentinel.
 * `reason` is REQUIRED here (unlike the restock DTO) — SA-089 calls this a FILING decision:
 * the audit log must record the operator's own reasoning, not just the pack they typed.
 */
export class ResolveParkedReversalDto {
  @IsInt()
  @Min(1)
  @Max(10000)
  pack!: number;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
