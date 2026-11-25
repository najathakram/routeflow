// SA-1263 A1: the api's copy of the estimate allowed-moves table. The API never value-imports `@routeflow/types` (its
// entry is raw TypeScript and `dist/` would crash at boot: no-runtime-workspace-imports.spec.ts), so the one table in
// `packages/types/api/estimate-moves.ts` is mirrored here, the way trip-grouping.ts mirrors its shared helper, and
// `estimate-moves.parity.spec.ts` pins the two equal cell by cell. Change a cell in both, or that spec goes red.
import type { EstimateStatus } from "@prisma/client";

export type EstimateAction = "edit" | "send" | "accept" | "decline" | "void" | "revert" | "convert";

export const ESTIMATE_MOVES: Readonly<Record<EstimateAction, readonly EstimateStatus[]>> = {
  edit: ["DRAFT"],
  send: ["DRAFT", "SENT", "ACCEPTED"],
  accept: ["DRAFT", "SENT", "ACCEPTED"],
  decline: ["DRAFT", "SENT", "ACCEPTED"],
  void: ["DRAFT", "SENT", "ACCEPTED"],
  revert: ["SENT", "ACCEPTED"],
  convert: ["ACCEPTED"],
};

export function canMoveEstimate(
  status: string | null | undefined,
  action: EstimateAction,
): boolean {
  return (ESTIMATE_MOVES[action] as readonly string[]).includes(status ?? "");
}
