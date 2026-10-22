import { BACKORDER_TAG_LABEL } from "@routeflow/types";

/** F02 / F30: the Backorder tag carries its reason as visible text (a hover title is invisible on touch). */
export function backorderTagText(pieces: number): string {
  return `${BACKORDER_TAG_LABEL} · ${pieces} ${pieces === 1 ? "pc" : "pcs"} past stock`;
}
