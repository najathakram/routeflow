import { IsIn, IsOptional, IsString } from "class-validator";

/**
 * The only statuses PATCH /route-runs/:id/stops/:stopId may set (#2109). COMPLETED is deliberately
 * absent: completion goes through the complete / complete-with-payment endpoints, which book the
 * delivery mutations, stock and payment guard. Writing the column here would strand those side
 * effects and blind the delivered-order demotion guard (B71 keys on stop.status === COMPLETED).
 */
export const PATCHABLE_STOP_STATUSES = ["IN_PROGRESS", "SKIPPED"] as const;
export type PatchableStopStatus = (typeof PATCHABLE_STOP_STATUSES)[number];

export class UpdateStopStatusDto {
  @IsIn(PATCHABLE_STOP_STATUSES) status: PatchableStopStatus;
  @IsOptional() @IsString() driverNote?: string;
}
