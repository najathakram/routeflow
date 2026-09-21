import { IsInt, Max, Min } from "class-validator";

/**
 * The operator's answer for a parked restock: the PACK only (units per box of the sold line). The quantity is
 * never retyped: it is the row's stored `returnedQty`. Under the global whitelist pipe any other field is
 * rejected.
 */
export class ResolveParkedRestockDto {
  @IsInt()
  @Min(2)
  @Max(10000)
  unitsPerBoxSupplied!: number;
}
