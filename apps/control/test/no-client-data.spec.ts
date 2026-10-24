/**
 * T59 (R30) — `apps/control` carries synthetic data only, never a real client's.
 *
 * spec.md R30: fixtures live under `apps/control/test/fixtures/acme/` and nothing under
 * `apps/control/**` (excluding `node_modules`/`dist`) matches the repo's client-data denylist
 * (`scripts/campaign/plane-denylist.json`, per lesson L-206: read the patterns at test time
 * rather than re-typing them, so an unrelated edit to that file cannot silently desync this
 * spec) plus a control-specific pin on the production Railway host pattern.
 *
 * test-plan.md notes this test is a **pin**: it passes today (no files exist yet under
 * `apps/control/` for it to scan) and becomes meaningful once WP0 and later tasks add real
 * fixture/source files — it is excluded from the WP0 red gate by name (test-plan.md §6).
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DENYLIST_FILE = path.join(REPO_ROOT, "scripts", "campaign", "plane-denylist.json");

interface DenylistPattern {
  name: string;
  regex: string;
  flags?: string;
}

function loadDenylistRegexes(): RegExp[] {
  const raw = JSON.parse(fs.readFileSync(DENYLIST_FILE, "utf8")) as {
    patterns: DenylistPattern[];
  };
  const fromFile = raw.patterns.map((p) => new RegExp(p.regex, p.flags ?? ""));
  // Control-specific pin (spec.md R30): the prod Railway host must never appear in fixtures,
  // source, or docs — it is a live-client-adjacent identifier even though it is not itself
  // tenant data.
  const railwayHost = /routeflow[a-z-]*-production\.up\.railway/i;
  return [...fromFile, railwayHost];
}

/** What can ship: tracked plus new-not-ignored files (never gitignored build output). */
function listFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "apps/control"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => path.join(REPO_ROOT, l));
}

describe("apps/control contains no client-identifying data (T59, R30)", () => {
  it("the denylist patterns file is readable", () => {
    expect(fs.existsSync(DENYLIST_FILE)).toBe(true);
  });

  it("no file under apps/control/** matches a denylist pattern", () => {
    const regexes = loadDenylistRegexes();
    const files = listFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(path.join(REPO_ROOT, "apps", "control", "src", "sources", "git.ts"));
    const hits: Array<{ file: string; pattern: string }> = [];

    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue; // binary/unreadable file — not a text denylist hit
      }
      for (const regex of regexes) {
        const matcher = new RegExp(
          regex.source,
          regex.flags.includes("g") ? regex.flags : regex.flags + "g",
        );
        if (matcher.test(text)) {
          hits.push({ file: path.relative(REPO_ROOT, file), pattern: regex.source });
        }
      }
    }

    expect(hits).toEqual([]);
  });
});
