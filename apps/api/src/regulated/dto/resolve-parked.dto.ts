import { IsInt, Max, Min } from "class-validator";

/**
 * The operator's answer for a parked row: the PACK only (units per box of the sold line). The quantity is
 * never retyped: it comes from the row's stored returned pieces/qty. Under the global whitelist pipe any
 * other field is rejected.
 */
export class ResolveParkedDto {
  @IsInt()
  @Min(2)
  @Max(10000)
  unitsPerBoxSupplied!: number;
}
