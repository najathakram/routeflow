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

import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONTROL_DIR = path.join(REPO_ROOT, "apps", "control");
const DENYLIST_FILE = path.join(REPO_ROOT, "scripts", "campaign", "plane-denylist.json");

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist"]);

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

function listFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      listFiles(path.join(dir, entry.name), out);
      continue;
    }
    out.push(path.join(dir, entry.name));
  }
  return out;
}

describe("apps/control contains no client-identifying data (T59, R30)", () => {
  it("the denylist patterns file is readable", () => {
    expect(fs.existsSync(DENYLIST_FILE)).toBe(true);
  });

  it("no file under apps/control/** matches a denylist pattern", () => {
    const regexes = loadDenylistRegexes();
    const files = listFiles(CONTROL_DIR);
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
