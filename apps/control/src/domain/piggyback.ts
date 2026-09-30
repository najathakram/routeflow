/** Piggyback candidates for a lane's open work (spec 5.2). */
export interface PiggybackCandidate {
  id: string;
  kind: string;
  status: string;
  lane: string | null;
  priority: string;
  effort: string;
  severity?: string;
  sensitive: boolean;
  files: Set<string>;
}
export interface PiggybackItem {
  id: string;
  score: number;
  shared: number;
  priority: string;
  sensitive: boolean;
  tag?: string;
}

const CAP = 8;
const SENSITIVE_TAG = "tier-1 — not bundleable";
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function piggyback(
  laneFiles: Set<string>,
  candidates: PiggybackCandidate[],
): { items: PiggybackItem[]; count: number } {
  const rows: PiggybackItem[] = [];
  for (const c of candidates) {
    if (c.status !== "planned" || c.lane !== null) continue;
    if (c.effort !== "S" && c.effort !== "unknown") continue;
    if (c.kind === "bug" && c.severity !== "low" && c.severity !== "medium") continue;
    if (!c.files.size) continue;
    let shared = 0;
    for (const f of c.files) if (laneFiles.has(f)) shared++;
    if (shared < 1) continue;
    const score = shared / c.files.size;
    if (score < 0.5) continue;
    const row: PiggybackItem = {
      id: c.id,
      score,
      shared,
      priority: c.priority,
      sensitive: c.sensitive,
    };
    if (c.sensitive) row.tag = SENSITIVE_TAG;
    rows.push(row);
  }
  rows.sort(
    (a, b) =>
      Number(a.sensitive) - Number(b.sensitive) ||
      b.score - a.score ||
      cmp(a.priority, b.priority) ||
      cmp(a.id, b.id),
  );
  const items = rows.slice(0, CAP);
  return { items, count: items.filter((i) => !i.sensitive).length };
}
