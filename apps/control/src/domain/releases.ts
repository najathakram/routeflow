/** Release readiness (spec 5.9; E35: due within 3 days with more than 25 % open is AT RISK). */
import type { ControlState } from "./types";

export const AT_RISK_DUE_SOON_DAYS = 3;
export const OPEN_RATIO = 0.25;
const DAY_MS = 86_400_000;
const DONE = new Set(["code-complete", "released"]);

export type ReadinessState = "READY" | "IN PROGRESS" | "AT RISK" | "SHIPPED";
export interface Readiness {
  state: ReadinessState;
  total: number;
  done: number;
  open: number;
  openRatio: number;
  moved: { from: string | null; to: string | null } | null;
}

const utcDay = (iso: string): number => Math.floor(Date.parse(iso) / DAY_MS);

export function releaseReadiness(
  state: Pick<ControlState, "tasks" | "releases">,
  id: string,
  now: string,
): Readiness {
  const rel = Object.prototype.hasOwnProperty.call(state.releases, id) ? state.releases[id] : null;
  let total = 0;
  let done = 0;
  for (const t of Object.values(state.tasks)) {
    if (t.release.value !== id || t.status.value === "dropped") continue;
    total++;
    if (DONE.has(t.status.value)) done++;
  }
  const open = total - done;
  const openRatio = total === 0 ? 0 : open / total;

  let moved: Readiness["moved"] = null;
  if (rel) {
    let best: string | null = null;
    for (const h of rel.history) {
      if (h.type !== "release.moved") continue;
      if (best === null || h.ts >= best) {
        best = h.ts;
        moved = { from: h.from, to: h.to };
      }
    }
  }

  let s: ReadinessState = "IN PROGRESS";
  if (rel && rel.status.value === "shipped") s = "SHIPPED";
  else if (total > 0 && open === 0) s = "READY";
  else if (rel && rel.shipDate.value !== null && /^\d{4}-\d{2}-\d{2}$/.test(rel.shipDate.value)) {
    const daysLeft = utcDay(rel.shipDate.value) - utcDay(now);
    if (daysLeft < 0 ? open > 0 : daysLeft <= AT_RISK_DUE_SOON_DAYS && openRatio > OPEN_RATIO) {
      s = "AT RISK";
    }
  }
  return { state: s, total, done, open, openRatio, moved };
}
