#!/usr/bin/env node
// Self-test for scripts/review-tier.mjs (T1-T6, M5, M7 and P1 of the R5 spec). Plain node; exit 1 on failure.
// Every case injects a fake git or gh runner: no repo, no network.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_TIER_MODE, main, tierOf } from "./review-tier.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`,
  );
  if (ok) passed++;
  else failed++;
}

const src = (n, p) => ({ path: p, added: n, deleted: 0 });
function fakeGit(rows) {
  return (args) => {
    if (args[0] === "merge-base") return "BASE0000\n";
    if (args[0] === "ls-tree") return ""; // no base rules file: the judge checkout's rules apply
    if (args[0] === "diff" && args.includes("--name-status"))
      return rows.map((r) => `M\0${r.path}\0`).join("");
    if (args[0] === "diff" && args.includes("--numstat"))
      return rows.map((r) => `${r.added}\t${r.deleted}\t${r.path}\0`).join("");
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}
async function run(argv, deps) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    log: { log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) },
    ...deps,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const tierFor = async (rows, extra = []) => {
  const r = await run(["--json", ...extra], { git: fakeGit(rows) });
  return { ...JSON.parse(r.out || "{}"), code: r.code };
};

check("dark mode", REVIEW_TIER_MODE, "dark");

const t1 = await tierFor([src(120, "apps/web/components/x.tsx")]);
check("T1 120 amber lines is tier 2", [t1.tier, t1.code], [2, 0]);

const t2 = await run([], { git: fakeGit([src(30, "apps/api/src/invoices/a.ts")]) });
check(
  "T2 30 red lines is tier 1 and names the red path",
  [/^review-tier: 1 — /.test(t2.out), t2.out.includes("apps/api/src/invoices/a.ts"), t2.code],
  [true, true, 0],
);

const t3 = await run([], { git: fakeGit([src(450, "apps/web/components/x.tsx")]) });
check(
  "T3 450 amber lines is tier 1 by size",
  [t3.out.startsWith("review-tier: 1"), t3.out.includes("450 counted lines > 400")],
  [true, true],
);

const t4 = await run([], { git: fakeGit([src(900, "docs/guide.md")]) });
check(
  "T4 900 docs lines is tier 2, lead read",
  [t4.out.startsWith("review-tier: 2"), t4.out.includes("docs: lead read, no agent")],
  [true, true],
);

// M5: size exclusion applies to the count only; every path is classified
const t5 = await tierFor([src(300, "apps/web/components/x.tsx"), src(800, "package-lock.json")]);
check(
  "T5 lockfile counts 0 lines but is still red: tier 1",
  [t5.tier, t5.counted, String(t5.reason).includes("package-lock.json")],
  [1, 300, true],
);

// M7: lead read only when every file is outside apps/, packages/, scripts/, .github/
const e2e = await run([], { git: fakeGit([src(30, "apps/web/e2e/x.spec.ts")]) });
check(
  "M7 e2e-only is one PASS, not a lead read",
  [
    e2e.out.startsWith("review-tier: 2"),
    e2e.out.includes("one PASS"),
    e2e.out.includes("lead read"),
  ],
  [true, true, false],
);
const readme = await run([], { git: fakeGit([src(30, "packages/ui/README.md")]) });
check(
  "M7 a markdown file under packages/ is one PASS",
  [readme.out.startsWith("review-tier: 2"), readme.out.includes("lead read")],
  [true, false],
);

// Long red lists are capped at 5 paths plus "+N"
const many = await run([], {
  git: fakeGit(Array.from({ length: 7 }, (_, i) => src(1, `apps/api/src/invoices/a${i + 1}.ts`))),
});
check(
  "red list shows 5 paths and +2",
  [many.out.includes("a5.ts"), many.out.includes("a6.ts"), many.out.includes("+2")],
  [true, false, true],
);

check(
  "usage warns that --pr misses rename sources and caps at 100 files",
  /rename/.test((await run(["--nope"], {})).err),
  true,
);

const t6 = await tierFor([src(5, "apps/api/railway.toml")]);
check("T6 a black path is tier 1", [t6.tier, t6.cls], [1, "black"]);

// tierOf is the one rule
check(
  "tierOf boundary: exactly 400 amber lines is tier 2",
  tierOf({ cls: "amber", counted: 400, red: [] })?.tier,
  2,
);

// --pr reads gh files
const gh = () =>
  JSON.stringify({
    files: [{ path: "apps/api/src/billing/x.ts", additions: 10, deletions: 2 }],
  });
const pr = await run(["--pr", "12", "--json"], { gh });
const prJson = JSON.parse(pr.out || "{}");
check("--pr uses gh files", [prJson.tier, prJson.counted], [1, 12]);

// usage and dark failure
check("unknown flag exits 2", (await run(["--nope"], {})).code, 2);
check("--repo is gone: exits 2", (await run(["--repo", "x"], {})).code, 2);
const boom = await run([], {
  git: () => {
    throw new Error("no git");
  },
});
check("dark: a git failure exits 0", boom.code, 0);

// P1: one tier rule, built from the two existing helpers; no second rule anywhere under scripts/
const own = readFileSync(path.join(HERE, "review-tier.mjs"), "utf8");
const definers = readdirSync(HERE, { recursive: true })
  .map((f) => String(f).split(path.sep).join("/"))
  .filter((f) => f.endsWith(".mjs") && !f.includes(".self-test.") && !f.includes("node_modules/"))
  .filter((f) =>
    /export function tierOf\b|\bconst TIER\b/.test(readFileSync(path.join(HERE, f), "utf8")),
  );
check(
  "P1 imports classifyMax and countLines, no second tier rule",
  [/\bclassifyMax\b/.test(own), /\bcountLines\b/.test(own), /\bWARN_AT\b/.test(own), definers],
  [true, true, true, ["review-tier.mjs"]],
);

console.log(`review-tier self-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
