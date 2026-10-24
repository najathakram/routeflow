/** File-set overlap between lanes (spec 5.2). Warn, never prohibit. */
export type OverlapLevel = "HOT" | "WARN" | "none";
export interface OverlapResult {
  shared: number;
  coef: number;
  level: OverlapLevel;
  paths: string[];
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function overlap(a: Set<string>, b: Set<string>): OverlapResult {
  if (!a.size || !b.size) return { shared: 0, coef: 0, level: "none", paths: [] };
  const paths = [...a].filter((p) => b.has(p)).sort(cmp);
  const shared = paths.length;
  const coef = shared / Math.min(a.size, b.size);
  const level: OverlapLevel =
    shared >= 3 && coef >= 0.5 ? "HOT" : shared >= 1 && coef >= 0.25 ? "WARN" : "none";
  return { shared, coef, level, paths };
}

export interface LaneFiles {
  lane: string;
  files: Set<string>;
  source: "diff" | "declared";
}
export interface OverlapPair extends OverlapResult {
  a: string;
  b: string;
  source: "diff" | "declared";
}

/** Every lane pair with level HOT/WARN; source is "diff" if either side is a real diff. */
export function overlapPairs(lanes: LaneFiles[]): OverlapPair[] {
  const sorted = [...lanes].filter((l) => l.files.size > 0).sort((x, y) => cmp(x.lane, y.lane));
  const out: OverlapPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const A = sorted[i];
      const B = sorted[j];
      if (A.lane === B.lane) continue;
      const r = overlap(A.files, B.files);
      if (r.level === "none") continue;
      const source = A.source === "diff" || B.source === "diff" ? "diff" : "declared";
      out.push({ a: A.lane, b: B.lane, ...r, source });
    }
  }
  return out.sort(
    (x, y) => y.coef - x.coef || y.shared - x.shared || cmp(x.a, y.a) || cmp(x.b, y.b),
  );
}
