import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Row 360 (B297 PR6): the backfill refuses a `--guard-sha` that predates B297 PR3's last writer commit, even when that
 * sha is an ancestor of HEAD. Without the minimum, a guard sha from before PR3 passed the ancestor check while the old
 * writers kept minting NULL-trio lines.
 */
const HREF = pathToFileURL(
  path.resolve(__dirname, "../../scripts/backfill-b297-rate-snapshot.mjs"),
).href;

function run(): { min: string; cases: Record<string, string> } {
  const code = `
    import { verifyGuardSha, MIN_GUARD_SHA } from "${HREF}";
    const MIN = MIN_GUARD_SHA, OLD = "0".repeat(40), NEW = "f".repeat(40);
    // fake history OLD < MIN < NEW <= HEAD: isAncestor(a, d) is true when a is at or before d
    const rank = new Map([[OLD, 0], [MIN, 1], [NEW, 2]]);
    const history = (a, d) => (rank.get(a) ?? 99) <= (rank.get(d) ?? 3);
    const tryIt = (g, isAncestor) => {
      try { verifyGuardSha(g, isAncestor, MIN); return "ok"; } catch (e) { return e.refuse ? e.message : "crash:" + e.message; }
    };
    console.log(JSON.stringify({ min: MIN, cases: {
      old: tryIt(OLD, history),
      atMin: tryIt(MIN, history),
      afterMin: tryIt(NEW, history),
      notAncestorOfHead: tryIt(NEW, (a, d) => a !== NEW && history(a, d)),
    } }));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(res.stderr).toBe("");
  return JSON.parse(res.stdout.trim());
}

describe("backfill-b297-rate-snapshot: minimum guard sha (row 360)", () => {
  const out = run();
  it("pins a 40-char sha", () => expect(out.min).toMatch(/^[0-9a-f]{40}$/));
  it("refuses a guard sha older than PR3 even though it is an ancestor of HEAD", () => {
    expect(out.cases.old).toMatch(/predates B297 PR3/);
  });
  it("accepts PR3's own commit and anything after it", () => {
    expect(out.cases.atMin).toBe("ok");
    expect(out.cases.afterMin).toBe("ok");
  });
  it("still refuses a guard sha that is not an ancestor of HEAD", () => {
    expect(out.cases.notAncestorOfHead).toMatch(/not an ancestor of this checkout's HEAD/);
  });
});
