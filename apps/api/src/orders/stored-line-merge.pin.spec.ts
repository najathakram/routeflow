import * as fs from "fs";
import * as path from "path";

/**
 * SA-841 pin: every server path that adds qty to an EXISTING stored order line goes through `mergeIntoStoredLine`
 * (stored-line-merge.ts). It fails on a new bypass.
 *
 * (a) The registry of the merge cores: each must import the helper. Cores not migrated yet sit on a SHRINKING
 *     allow-list (with the PR that migrates them); an allow-listed core that already imports the helper is red, so
 *     the list can only shrink.
 * (b) A source scan of apps/api/src (non-spec) for stored-line add arithmetic. A hit outside the helper, a pending
 *     core or a named exemption is red. Each pattern first proves it matches a known-bad fixture string, so a broken
 *     regex can never pass green.
 * (c) The helper's `bare` / `output` / `livePack` params are required (no defaults): `tsc` is the backstop.
 */
const SRC = path.resolve(__dirname, "..");
const HELPER = "orders/stored-line-merge.ts";

/** Every merge core, by file. */
const CORES = [
  "orders/orders.service.ts",
  "orders/merge-items.ts",
  "orders/buyer-merge-pricing.ts",
];

/** SHRINKING: cores still on their own arithmetic, each with the PR that moves it onto the helper. */
const PENDING_CORES: Record<string, string> = {
  "orders/merge-items.ts": "SA-841 PR-2 (P2 staff scan-merge B207 + P3 buyer merge)",
  "orders/buyer-merge-pricing.ts":
    "SA-841 PR-3 (P4/P5 pending-order merge + force consolidate, money-identical)",
};

/** Not stored-line adds at all: each match is named and justified. */
const EXEMPT: Record<string, string> = {
  "sales-facts/sales-facts.service.ts":
    "a reporting sum of sold pieces across lines; it never writes a line",
};

const PATTERNS: { re: RegExp; bad: string }[] = [
  {
    re: /Number\((existing|li|line|src)\.qty\)\s*\+/,
    bad: "const newQty = Number(existing.qty) + addQty;",
  },
  { re: /acc\.(boxes|pieces)\s*\+=/, bad: "acc.boxes += Number(item.boxes ?? 0);" },
  { re: /sellingUnit \? q \* upb/, bad: "return sum + (sellingUnit ? q * upb : q);" },
];

const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
const importsHelper = (rel: string) =>
  /from\s+["']\.\/stored-line-merge["']/.test(read(rel)) &&
  /\bmergeIntoStoredLine\b/.test(read(rel));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "testing") walk(p, out);
    } else if (/\.ts$/.test(e.name) && !/\.(spec|db\.spec)\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("SA-841 pin: stored-line adds go through mergeIntoStoredLine", () => {
  it("(a) every merge core imports the helper, unless it is still on the shrinking allow-list", () => {
    for (const core of CORES) {
      if (core in PENDING_CORES) continue;
      expect({ core, importsHelper: importsHelper(core) }).toEqual({ core, importsHelper: true });
    }
  });

  it("(a) the allow-list only shrinks: a pending core that already imports the helper must leave the list", () => {
    for (const core of Object.keys(PENDING_CORES)) {
      expect({ core, stillPendingButImports: importsHelper(core) }).toEqual({
        core,
        stillPendingButImports: false,
      });
    }
  });

  it("(b) each pattern matches its known-bad fixture (a broken regex cannot pass green)", () => {
    for (const { re, bad } of PATTERNS)
      expect({ re: String(re), hit: re.test(bad) }).toEqual({ re: String(re), hit: true });
  });

  it("(b) no stored-line add arithmetic outside the helper, a pending core or a named exemption", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel === HELPER || rel in PENDING_CORES || rel in EXEMPT) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (PATTERNS.some(({ re }) => re.test(line)))
            hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("(b) each exemption still has the pattern it is exempted for (a stale exemption must be removed)", () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect({ rel, matches: PATTERNS.some(({ re }) => re.test(read(rel))) }).toEqual({
        rel,
        matches: true,
      });
    }
  });
});
