#!/usr/bin/env node
// Self-test for scripts/plan.mjs (the plan.json checker). Plain node; exit 0 when every check
// passes, 1 otherwise. P1-P11 follow the R2 spec; the type, malformed-JSON, BOM and check-all cases
// follow the review. `gh` is injected: no network.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCK_AT, WARN_AT } from "./lib/pr-size.mjs";
import { checkAll, main } from "./plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` got ${JSON.stringify(got)}`}`);
  if (ok) passed += 1;
  else failed += 1;
};
const j = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "plan-st-")));
const slice = (id, o = {}) => ({
  id,
  title: `slice ${id}`,
  files: [`apps/api/src/${id.toLowerCase()}.ts`],
  testIds: [`T-${id}`],
  dependsOn: [],
  estLines: 100,
  branch: `feat/acme-${id.toLowerCase()}`,
  pr: null,
  ...o,
});
const good = () => ({
  slug: "acme-feature",
  criteria: [
    {
      id: "AC1",
      ears: "When a buyer saves, the system shall store it.",
      testIds: ["T-S1", "T-S3"],
    },
    { id: "AC2", ears: "The system shall round every amount.", testIds: ["T-S2"] },
  ],
  slices: [slice("S1"), slice("S2", { dependsOn: ["S1"] }), slice("S3")],
});
// set(plan, "slices.1.dependsOn", v): write v at a dotted path (an index one past the end appends)
const set = (o, p, v) => {
  const k = p.split(".");
  const last = k.pop();
  k.reduce((a, x) => a[x], o)[last] = v;
  return o;
};
let n = 0;
const runRaw = async (text, args = ["--check"], deps = {}) => {
  const file = path.join(tmp, `p${n++}.plan.json`);
  writeFileSync(file, text);
  const lines = [];
  const code = await main([file, ...args], { log: (l) => lines.push(l), ...deps });
  return { code, out: lines.join("\n"), file };
};
const run = (plan, args, deps) => runRaw(JSON.stringify(plan), args, deps);
const codeOf = async (plan) => (await run(plan)).code;

// [dotted path, new value, exact message]: each must exit 1 and print the message, never crash
const S1TS = "apps/api/src/s1.ts";
const BAD = [
  ["slices.1.dependsOn", ["S9"], "S2 depends on unknown S9"], // P2
  ["slices.0.dependsOn", ["S2"], "cycle S1 → S2 → S1"], // P3
  ["slices.0.dependsOn", ["S1"], "cycle S1 → S1"],
  ["slices.2.id", "S1", "duplicate id S1"],
  ["slices.2.files", [S1TS], `${S1TS} owned by S1 and S3 with no dependsOn chain`], // P4
  ["slices.2.files", ["apps/api/src/s2.ts"], "s2.ts owned by S2 and S3 with no dependsOn chain"],
  ["criteria.1.testIds", [], "AC2 has no test"], // P5
  ["criteria.0.testIds", ["T-S1", "T-NOBODY"], "AC1 test T-NOBODY is owned by no slice"], // P6
  ["criteria.0.ears", "the system should be fast", "AC1 is not EARS"], // P7
  ["slices.0.estLines", BLOCK_AT + 50, `S1 estLines ${BLOCK_AT + 50} over BLOCK_AT ${BLOCK_AT}`],
  ["slices.3", { title: "x" }, "slices[3] has no id"],
  ["slices.3", null, "slices[3] must be an object"],
  ["criteria.2", null, "criteria[2] must be an object"],
  ["slices", {}, "slices must be an array"],
  ["slices.1.dependsOn", "S1", "S2.dependsOn must be an array of slice ids"],
  ["slices.0.files", [1], "S1.files must be an array of strings"],
  ["slices.0.testIds", "T", "S1.testIds must be an array of test ids"],
  ["criteria.0.testIds", "T", "AC1.testIds must be an array of test ids"],
  ["slices.0.estLines", -5, "S1.estLines must be a non-negative integer"],
  ["slices.0.estLines", 1.5, "S1.estLines must be a non-negative integer"],
  ["slices.0.pr", "--web", "S1.pr must be null or a positive integer"],
  ["slices.0.pr", 0, "S1.pr must be null or a positive integer"],
  ["slices.0.branch", "--web", 'S1.branch must be a string not starting with "-"'],
];

try {
  // P1
  let r = await run(good());
  check("P1 valid plan: --check exit 0", r.code, 0);
  r = await run(good(), ["--waves", "--json"]);
  const ids = j(r.out)?.waves?.map((w) => w.map((s) => s.id));
  check("P1 waves = [[S1,S3],[S2]]", ids, [["S1", "S3"], ["S2"]]);

  for (const [p, v, msg] of BAD) {
    try {
      r = await run(set(good(), p, v));
    } catch (e) {
      r = { code: "crash", out: String(e.message) };
    }
    check(msg, [r.code, r.out.includes(msg)], [1, true]);
  }
  r = await run(set(good(), "slices.1.dependsOn", ["S9"]), ["--waves"]);
  check("--waves checks first", r.code, 1);

  // sharing a file is fine when a dependsOn chain orders the two slices
  check("shared file with a chain: ok", await codeOf(set(good(), "slices.1.files", [S1TS])), 0);

  // P8: the five EARS patterns and a bare capitalised name
  const ears = [
    "The api shall reject empty names.",
    "When a driver arrives, the app shall mark the stop done.",
    "While a route is locked, the app shall hide the edit button.",
    "If the upload fails, then the app shall keep the draft.",
    "Where tax is enabled, the invoice shall show a tax line.",
    "RouteFlow shall round every amount.",
  ];
  for (const e of ears)
    check(`P8 accepted: ${e.slice(0, 22)}`, await codeOf(set(good(), "criteria.0.ears", e)), 0);

  // P9: over WARN_AT warns (exit 0, printed)
  r = await run(set(good(), "slices.0.estLines", WARN_AT + 50));
  const warned = r.out.includes(`warning: S1 estLines ${WARN_AT + 50} over WARN_AT ${WARN_AT}`);
  check("P9 over WARN_AT: exit 0 with a warning", [r.code, warned], [0, true]);

  // P10: five states, no network
  const p10 = good();
  p10.slices[0].pr = 11;
  p10.slices[1].pr = 12;
  p10.slices.push(slice("S4", { pr: 13 }), slice("S5", { pr: 14 }));
  const gh = (args) => {
    const s = args.join(" ");
    if (s.includes("pr view 11")) return '{"state":"MERGED"}';
    if (s.includes("pr view 12")) return '{"state":"OPEN"}';
    if (s.includes("pr view 13")) return '{"state":"CLOSED"}';
    if (s.includes("--head feat/acme-s3")) return "[]";
    throw new Error("boom");
  };
  r = await run(p10, ["--status", "--json"], { gh });
  const states = j(r.out)?.status?.map((s) => [s.id, s.state]);
  check("P10 status states", states, [
    ["S1", "merged"],
    ["S2", "open"],
    ["S3", "missing"],
    ["S4", "closed"],
    ["S5", "error"],
  ]);
  r = await run(good(), ["--status"], {
    gh: () => {
      throw new Error("not logged in");
    },
  });
  check(
    "every row error: summary, exit 0",
    [r.code, r.out.includes("gh failed for every")],
    [0, true],
  );

  // malformed JSON names the file; a BOM is stripped
  r = await runRaw("{ nope");
  check(
    "malformed JSON names the file",
    [r.code, r.out.includes(path.basename(r.file))],
    [1, true],
  );
  check("BOM stripped", (await runRaw(`﻿${JSON.stringify(good())}`)).code, 0);

  // --check-all: a missing folder is ok; each problem is prefixed with its file name once
  check(
    "check-all: missing folder exit 0",
    checkAll(path.join(tmp, "none"), () => {}),
    0,
  );
  const dir = path.join(tmp, "plans");
  mkdirSync(dir);
  const files = {
    "a-good": JSON.stringify(good()),
    "b-bad": JSON.stringify(set(good(), "criteria.1.testIds", [])),
    "c-broken": "{ nope",
    "d-null": "null",
  };
  for (const [k, v] of Object.entries(files)) writeFileSync(path.join(dir, `${k}.plan.json`), v);
  const lines = [];
  check(
    "check-all: bad folder exit 1",
    checkAll(dir, (l) => lines.push(l)),
    1,
  );
  check("check-all: prefixed once", lines.includes("b-bad.plan.json: AC2 has no test"), true);
  check(
    "check-all: broken file",
    lines.filter((l) => l.startsWith("c-broken.plan.json: ")).length,
    1,
  );
  check("check-all: null plan", lines.includes("d-null.plan.json: plan is not an object"), true);
  check(
    "check-all: good file silent",
    lines.some((l) => l.startsWith("a-good")),
    false,
  );

  // P11
  const src = readFileSync(path.join(HERE, "plan.mjs"), "utf8");
  const imported =
    /import\s*\{[^}]*\bBLOCK_AT\b[^}]*\bWARN_AT\b[^}]*\}\s*from\s*"\.\/lib\/pr-size\.mjs"/;
  check("P11 imports WARN_AT and BLOCK_AT, never redefines", imported.test(src), true);
  check("P11 no local WARN_AT/BLOCK_AT", /(const|let|var)\s+(WARN_AT|BLOCK_AT)\b/.test(src), false);
  const verify = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).scripts
    .verify;
  const wired = ["scripts/plan.self-test.mjs", "scripts/plan.mjs --check-all"];
  check(
    "P11 verify runs the self-test and --check-all",
    wired.every((s) => verify.includes(s)),
    true,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`plan self-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
