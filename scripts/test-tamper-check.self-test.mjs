#!/usr/bin/env node
// Self-test for scripts/test-tamper-check.mjs (R4, dark). Plain node; exit 0 when every check passes.
// A table of synthetic unified diffs goes through scanDiff; the CLI case runs the real script against a
// planted repo (trailer parsing, text report, dark exit code).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { TAMPER_MODE, isTestFile, parseTrailers, scanDiff } from "./test-tamper-check.mjs";

let passed = 0;
let failed = 0;
const check = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  const detail = same ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
  console.log(`${same ? "  ok  " : "  FAIL"} ${name}${detail}`);
  if (same) passed += 1;
  else failed += 1;
};

/** Diff of `file`: `lines` ("-"/"+" prefixed) form the hunk at line 10; each extra [at, lines] is a hunk. */
const diffOf = (file, lines, ...more) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` +
  [[10, lines], ...more].map(([at, l]) => `@@ -${at} +${at} @@\n${l.join("\n")}\n`).join("");
const SPEC = "src/a.spec.ts";
const e = (m, s = "x") => `  expect(${s}).${m};`;
/** Hunk replacing `expect(<s>).<before>` with `expect(<t ?? s>).<after>`. */
const sw = (before, after, s = "x", t = s) => diffOf(SPEC, ["-" + e(before, s), "+" + e(after, t)]);
const D = SPEC.replace("a.spec.ts", "gone.spec.ts");

check("mode is dark", TAMPER_MODE, "dark");
check(
  "isTestFile",
  ["a.spec.ts", "m/__tests__/q.ts", "s/a.self-test.mjs", "a.ts"].map(isTestFile),
  [true, true, true, false],
);
check("parseTrailers", parseTrailers("fix: x\n\nTest-Change: replaced by b\nOther: y\n"), [
  "replaced by b",
]);

// [name, diff, hit kinds in order]
const rm = diffOf(SPEC, ["-" + e("toBe(1)")]);
const CASES = [
  ["removed assertion, nothing added", rm, ["assertion-removed"]],
  ["replaced assertion (same count)", sw("toBe(1)", "toBe(1)", "a", "c"), []],
  ["commented-out assertion removed", diffOf(SPEC, ["-  // expect(a).toBe(1);"]), []],
  ["toEqual -> toBeDefined", sw("toEqual(5)", "toBeDefined()"), ["loosened"]],
  ["toBe -> not.toBeNull", sw("toBe(1)", "not.toBeNull()"), ["loosened"]],
  ["number -> expect.any(Number)", sw("toEqual(3)", "toEqual(expect.any(Number))"), ["loosened"]],
  ["toBeCloseTo 4 -> 1", sw("toBeCloseTo(1.5, 4)", "toBeCloseTo(1.5, 1)"), ["precision-loosened"]],
  [".resolves.toBe -> toBeDefined", sw("resolves.toBe(1)", "resolves.toBeDefined()"), ["loosened"]],
  ["subject swap + loosened", sw("toBe(12.5)", "toBeDefined()", "total", "other"), ["loosened"]],
  ["toBeDefined -> toBe(3) is stricter", sw("toBeDefined()", "toBe(3)"), []],
  [
    "two removed, one added = one hit",
    diffOf(SPEC, ["-" + e("toBe(1)", "a"), "-" + e("toBe(2)", "b"), "+" + e("toBe(3)", "a")]),
    ["assertion-removed"],
  ],
  [
    "skip/only/xit/todo added",
    diffOf(SPEC, [
      '+  it.skip("a", f);',
      '+  describe.only("b");',
      '+  xit("c");',
      '+  it.todo("d");',
    ]),
    Array(4).fill("skip-added"),
  ],
  [
    "@ts-ignore, eslint-disable added",
    diffOf(SPEC, ["+  // @ts-ignore", "+  // eslint-disable-next-line"]),
    Array(2).fill("suppression-added"),
  ],
  [
    "tamper-ok on another added line of the hunk",
    diffOf(SPEC, ["-" + e("toEqual(1)"), "+" + e("toBeTruthy()"), "+  // tamper-ok: no"]),
    ["loosened"],
  ],
  [
    "tamper-ok in a different hunk",
    diffOf(
      SPEC,
      ["-" + e("toEqual(1)"), "+" + e("toBeTruthy()")],
      [30, ["+  g(); // tamper-ok: n"]],
    ),
    ["loosened"],
  ],
  [
    "assertion moved to another hunk",
    diffOf(SPEC, ["-" + e("toBe(1)", "a")], [40, ["+" + e("toBe(1)", "b")]]),
    [],
  ],
  ["removed `import assert`", diffOf(SPEC, ['-import assert from "node:assert";']), []],
  ["removed `assert.equal(`", diffOf(SPEC, ["-  assert.equal(a, 1);"]), ["assertion-removed"]],
  ["removed expect( in docs", diffOf("docs/x.md", ["-Use expect(total) here."]), []],
  ["removed expect( in non-test source", diffOf("src/a.ts", ["-" + e("toBe(1)")]), []],
];
for (const [name, diff, want] of CASES) {
  check(
    name,
    scanDiff(diff).hits.map((h) => h.kind),
    want,
  );
}

const at = scanDiff(rm).hits[0];
check("hit carries file and hunk line", [at?.file, at?.line], [SPEC, 10]);
const okLine = scanDiff(
  diffOf(SPEC, ["-" + e("toEqual(1)"), "+" + e("toBeTruthy()") + " // tamper-ok: fixture"]),
);
check(
  "tamper-ok on the added line suppresses, prints the reason",
  [okLine.hits.length, okLine.allowed.map((a) => a.reason)],
  [0, ["fixture"]],
);
const okRem = scanDiff(diffOf(SPEC, ["-" + e("toBe(1)"), "+  go(); // tamper-ok: moved"]));
check(
  "a removal is allowed by tamper-ok on an added line of its hunk",
  [okRem.hits.length, okRem.allowed.length],
  [0, 1],
);
const del =
  `diff --git a/${D} b/${D}\ndeleted file mode 100644\nindex 1111111..0000000\n` +
  `--- a/${D}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-expect(1).toBe(1);\n-x;\n`;
const allowedDel = scanDiff(del, { trailers: ["replaced by x"] });
check(
  "deleted test file is one hit",
  scanDiff(del).hits.map((h) => h.kind),
  ["file-deleted"],
);
check(
  "Test-Change trailer allows the delete",
  [allowedDel.hits.length, allowedDel.allowed[0]?.reason],
  [0, "replaced by x"],
);

// CLI against a planted repo: trailer parsing, text report, dark exit code.
const sh = (dir, ...a) => {
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  const r = spawnSync("git", [...id, "-c", "core.hooksPath=", ...a], {
    cwd: dir,
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-pst-")));
try {
  sh(dir, "init", "-q", "-b", "master");
  if (
    sh(dir, "rev-parse", "--show-toplevel").toLowerCase() !== dir.replace(/\\/g, "/").toLowerCase()
  )
    throw new Error(`planted repo is not its own toplevel (GIT_* leaked): ${dir}`);
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  const commit = (msg) => (sh(dir, "add", "."), sh(dir, "commit", "-q", "-m", msg));
  write(SPEC, "expect(1).toBe(1);\n");
  write(D, "expect(2).toBe(2);\n");
  commit("init");
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-tamper-check.mjs");
  const run = () =>
    spawnSync(process.execPath, [script, "--base", "master"], {
      cwd: dir,
      encoding: "utf8",
      env: scrubbedGitEnv(),
    });
  sh(dir, "checkout", "-q", "-b", "fix/x");
  write(SPEC, "// nothing\n");
  sh(dir, "rm", "-q", D);
  commit("fix: x");
  const bad = run();
  const hit = (k) => new RegExp(`^TAMPER  ${k}  src/`, "m").test(bad.stdout);
  check(
    "CLI dark: exit 0 with hits",
    [bad.status, hit("assertion-removed"), hit("file-deleted")],
    [0, true, true],
  );
  sh(dir, "commit", "-q", "--allow-empty", "-m", "fix: y\n\nTest-Change: replaced by b.spec.ts");
  const out = run().stdout;
  check(
    "CLI: Test-Change trailer allows the delete",
    [
      /^allowed file-deleted .*replaced by b\.spec\.ts/m.test(out),
      /1 hit\(s\), 1 allowed/.test(out),
    ],
    [true, true],
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`test-tamper-check self-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
