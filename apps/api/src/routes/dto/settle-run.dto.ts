import { IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";

/**
 * F05 / R6 — POST /route-runs/:id/settlement body. The driver (or operator,
 * post-hoc) reports what was physically counted; the server computes
 * `expected` itself from `getRunCashCollections` and never trusts a
 * client-supplied expected figure. `varianceReason` is required by the
 * service (not this DTO — the threshold is `|variance| > 0.01`, which needs
 * the server-computed expected total to evaluate) when the counted amount
 * doesn't reconcile.
 */
export class SettleRunDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) countedCash: number;
  @IsOptional() @IsString() @MaxLength(500) varianceReason?: string;
}
