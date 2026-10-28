#!/usr/bin/env node
// Self-test for scripts/pr-size.mjs + scripts/lib/pr-size.mjs (S1-S11 of the R3 spec).
// Plain node; exit 0 when every check passes, 1 otherwise. S9 builds a throwaway git repo in the OS
// temp dir and runs the real CLI against it; S10 reads scripts/fixtures/pr-size/ through an injected gh
// runner (no network); every other case injects a fake git.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_AT,
  WARN_AT,
  countLines,
  parseNumstatZ,
  rowsFromGhFiles,
  sizeVerdict,
} from "./lib/pr-size.mjs";
import { main, parseArgs } from "./pr-size.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { registrySource } from "./lib/registry-root.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(HERE, "pr-size.mjs");
const FIXTURE = path.join(HERE, "fixtures", "pr-size", "gh-prs.json");
const J = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
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

// ─── fakes ───────────────────────────────────────────────────────────────────────────────────
const numstatZ = (rows) => rows.map((r) => `${r.added}\t${r.deleted}\t${r.path}\0`).join("");
function fakeGit(rows, message = "feat: x\n") {
  return (args) => {
    if (args[0] === "merge-base") return "BASE0000\n";
    if (args[0] === "ls-tree") return ""; // no base rules file: the judge checkout's rules apply
    if (args[0] === "log") return message;
    if (args[0] === "diff" && args.includes("--name-status"))
      return rows.map((r) => `M\0${r.path}\0`).join("");
    if (args[0] === "diff" && args.includes("--numstat")) return numstatZ(rows);
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
const src = (n, p = "apps/api/src/x.ts") => ({ path: p, added: n, deleted: 0 });

// ─── thresholds and the pure rule ────────────────────────────────────────────────────────────
check("thresholds", [WARN_AT, BLOCK_AT], [400, 600]);

// S1
const s1 = await run(["--base", "origin/master", "--json"], { git: fakeGit([src(380)]) });
check("S1 380 source lines is ok", [J(s1.out).verdict, s1.code], ["ok", 0]);

// S2
const s2 = await run(["--base", "origin/master"], { git: fakeGit([src(450)]) });
check(
  "S2 450 lines warns, exit 0 in dark mode",
  [/450 counted lines.*warn/.test(s2.out), s2.code],
  [true, 0],
);

// S3
const s3 = await run([], { git: fakeGit([src(700)]) });
check(
  "S3 700 lines reports block, exit 0 in dark mode",
  [/block/.test(s3.out), s3.code],
  [true, 0],
);
const s3e = await run([], { git: fakeGit([src(700)]), mode: "enforced" });
check("S3 enforced mode exits 1 on block", s3e.code, 1);
const s3w = await run([], { git: fakeGit([src(450)]), mode: "enforced" });
check("S3 enforced mode exits 0 on warn", s3w.code, 0);

// S4
const s4rows = [
  src(300),
  { path: "package-lock.json", added: 600, deleted: 300 },
  { path: "scripts/fixtures/pr-size/gh-prs.json", added: 500, deleted: 0 },
];
const s4 = await run(["--json"], { git: fakeGit(s4rows) });
const s4j = J(s4.out);
check(
  "S4 lockfile and fixtures are excluded",
  [s4j.counted, s4j.excluded, s4j.verdict],
  [300, 1400, "ok"],
);
check(
  "S4 bookkeeping ledgers and snapshots are excluded",
  countLines([
    src(10, ".claude/code-map/api.md"),
    src(10, ".claude/lessons/LESSONS.md"),
    src(10, `${registrySource().prefix}/bugs.jsonl`),
    src(10, ".claude/pipeline/x.jsonl"),
    src(10, "apps/web/__snapshots__/a.snap"),
    src(10, "apps/web/b.snap"),
    src(10, "apps/api/src/generated/c.ts"),
    src(10, "apps/api/dist/d.js"),
    src(7),
  ]),
  { counted: 7, excluded: 80, files: 9, binary: [] },
);

// S5
const s5 = await run(["--json"], { git: fakeGit([src(900, "docs/guide.md")]) });
check("S5 900 docs lines are ok (green-only)", J(s5.out).verdict, "ok");
check(
  "S5 green-only does not hide source",
  J((await run(["--json"], { git: fakeGit([src(900, "docs/guide.md"), src(10)]) })).out).verdict,
  "block",
);

// S6
const s6 = await run([], {
  git: fakeGit([src(700)], "feat: vendor\n\nPR-Size-Override: vendored engine\n"),
});
check(
  "S6 override turns block into warn-override and prints the reason",
  [/warn-override/.test(s6.out), /vendored engine/.test(s6.out), s6.code],
  [true, true, 0],
);
const s6e = await run([], {
  git: fakeGit([src(700)], "feat: vendor\n\nPR-Size-Override: vendored engine\n"),
  mode: "enforced",
});
check("S6 override passes in enforced mode", s6e.code, 0);
check("S6 verdict helper", sizeVerdict(700, { override: "r" }), "warn-override");

// S7
const s7 = countLines([{ path: "assets/logo.png", added: "-", deleted: "-" }, src(5)]);
check("S7 binary row counts 0 and is listed", [s7.counted, s7.binary], [5, ["assets/logo.png"]]);
check(
  "S7 numstat -z binary row parses",
  parseNumstatZ("-\t-\tassets/logo.png\0").map((r) => r.added),
  ["-"],
);
check(
  "S7 numstat -z rename uses the new path",
  parseNumstatZ("3\t1\t\0old.ts\0new.ts\0").map((r) => r.path),
  ["new.ts"],
);

// S8
const s8rows = [
  src(300),
  { path: "package-lock.json", added: 50, deleted: 20 },
  src(40, "docs/a.md"),
];
const fromGit = await run(["--json"], { git: fakeGit(s8rows) });
const ghFiles = s8rows.map((r) => ({ path: r.path, additions: r.added, deletions: r.deleted }));
const fromGh = await run(["--pr", "7", "--json"], {
  gh: () =>
    JSON.stringify({
      files: ghFiles,
      headRefOid: "abc",
      commits: [{ messageHeadline: "feat: x", messageBody: "" }],
    }),
});
const pick = (r) => {
  const j = J(r.out);
  return [j.counted, j.excluded, j.verdict];
};
check("S8 numstat and gh files give one result", pick(fromGh), pick(fromGit));
check(
  "S8 rowsFromGhFiles maps additions/deletions",
  countLines(rowsFromGhFiles(ghFiles)),
  countLines(s8rows),
);

// --github annotation
const gh1 = await run(["--github"], { git: fakeGit([src(450)]) });
check(
  "--github annotates warn",
  gh1.out.split("\n").some((l) => l.startsWith("::warning::pr-size:")),
  true,
);
const gh2 = await run(["--github"], { git: fakeGit([src(10)]) });
check("--github is silent on ok", gh2.out.includes("::warning::"), false);

// usage errors
check("bad flag exits 2", (await run(["--nope"], { git: fakeGit([]) })).code, 2);
check("--base without a value exits 2", (await run(["--base"], { git: fakeGit([]) })).code, 2);
check(
  "--pr and --since are exclusive",
  (await run(["--pr", "1", "--since", "2026-10-01"], {})).code,
  2,
);
check("--since must be a date", parseArgs(["--since", "soon"]).error !== undefined, true);
const boom = () => {
  throw new Error("boom");
};
const darkFail = await run([], { git: boom });
check(
  "dark: a git failure is reported and never fails the push",
  [darkFail.code, /cannot measure: boom/.test(darkFail.err)],
  [0, true],
);
check("enforced: a git failure exits 2", (await run([], { git: boom, mode: "enforced" })).code, 2);

// CI: a pull_request checkout's HEAD is GitHub's merge commit, so the trailer is read from --message-ref.
{
  const logArgs = [];
  const base = fakeGit([src(700)], "feat: vendor\n\nPR-Size-Override: vendored engine\n");
  const git = (args) => {
    if (args[0] === "log") logArgs.push(args.at(-1));
    return base(args);
  };
  const r = await run(["--message-ref", "abc123"], { git });
  check(
    "--message-ref reads the trailer from that commit",
    [logArgs, /warn-override/.test(r.out)],
    [["abc123"], true],
  );
  check(
    "--message-ref without the git mode is a usage error",
    parseArgs(["--pr", "1", "--message-ref", "x"]).error !== undefined,
    true,
  );
}

// gh lists at most 100 files per PR: a PR at that cap is a floor, not a count.
{
  const files = Array.from({ length: 100 }, (_, i) => ({
    path: `apps/api/src/f${i}.ts`,
    additions: 10,
    deletions: 0,
  }));
  const r = await run(["--pr", "9", "--json"], {
    gh: () => JSON.stringify({ files, headRefOid: "a", commits: [] }),
  });
  check("a PR at gh's file cap is flagged truncated", J(r.out).truncated, true);
}

// S9: a planted repo, branch two commits past base
{
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "pr-size-")));
  try {
    const git = (...a) => {
      const r = spawnSync(
        "git",
        [
          ...["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t"],
          ...["-c", "commit.gpgsign=false", "-c", "core.hooksPath="],
          ...a,
        ],
        { encoding: "utf8", env: scrubbedGitEnv() },
      );
      if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    const put = (f, n) => {
      mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      writeFileSync(path.join(dir, f), Array.from({ length: n }, (_, i) => `line ${i}\n`).join(""));
      git("add", f);
    };
    git("init", "-q", "-b", "master");
    // A leaked GIT_DIR would resolve to the outer repo: stop before any write touches it.
    const top = git("rev-parse", "--show-toplevel").trim();
    const norm = (p) => p.split(path.sep).join("/").replace(/\/+$/, "").toLowerCase();
    if (norm(top) !== norm(dir)) throw new Error(`S9 repo resolved to ${top}, not ${dir}`);
    put("README.md", 1);
    git("commit", "-q", "-m", "chore: base");
    git("checkout", "-q", "-b", "feat/x");
    put("apps/api/src/a.ts", 150);
    git("commit", "-q", "-m", "feat: a");
    put("apps/api/src/b.ts", 200);
    git("commit", "-q", "-m", "feat: b\n\nPR-Size-Override: planted");
    const r = spawnSync(process.execPath, [CLI, "--repo", dir, "--base", "master", "--json"], {
      encoding: "utf8",
      env: scrubbedGitEnv(),
    });
    const j = J(r.stdout || "{}");
    check(
      "S9 CLI counts both commits since the merge-base",
      [r.status, j.counted, j.override],
      [0, 350, "planted"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// S10: --since over a fixture of 6 merged PRs (injected gh, no network)
{
  const body = readFileSync(FIXTURE, "utf8");
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return body;
  };
  const now = Date.parse("2026-10-20T12:00:00Z");
  const r = await run(["--since", "2026-10-01", "--json"], { gh, now });
  const j = J(r.out);
  check(
    "S10 distribution over 6 PRs",
    [j.count, j.median, j.p90, j.overWarn, j.overBlock, j.wouldWarn, j.wouldBlock],
    [6, 415, 700, 3, 1, 2, 1],
  );
  check("S10 would-block PR is listed with its counted size", j.blockPrs, [
    { number: 5, title: "pr 5", counted: 700 },
  ]);
  check("S10 pages in 7-day slices", calls.length, 3);
  check("S10 exit 0 in dark mode", r.code, 0);
  const text = await run(["--since", "2026-10-01"], { gh, now });
  check("S10 text report lists the over-600 PR", /#5.*700/.test(text.out), true);
  const cut = await run(["--since", "2026-10-01"], { gh, now, limit: 6 });
  check(
    "S10 a slice at the gh limit fails loudly",
    [cut.code, /truncated/.test(cut.err)],
    [2, true],
  );
}

// S11: inventory pin
{
  const hook = readFileSync(path.join(ROOT, ".husky", "pre-push"), "utf8");
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  check(
    "S11 pre-push runs pr-size after the dark risk-class line",
    /risk-class\.mjs[^\n]*\n(?:[^\n]*\n)*?node scripts\/pr-size\.mjs 2>\/dev\/null \|\| true/.test(
      hook,
    ),
    true,
  );
  check(
    "S11 ci.yml runs pr-size dark on pull_request",
    [
      /node scripts\/pr-size\.mjs --base "origin\/\$\{BASE_REF\}" --message-ref "\$\{HEAD_SHA\}" --github/.test(
        ci,
      ),
      /name: PR size \(dark\)\s+if: github\.event_name == 'pull_request'\s+continue-on-error: true/.test(
        ci,
      ),
    ],
    [true, true],
  );
  const owners = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        /\.(mjs|js|cjs|ts)$/.test(e.name) &&
        /\b(?:const|let|var)\s+(?:WARN_AT|BLOCK_AT)\b/.test(readFileSync(p, "utf8"))
      )
        owners.push(path.relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  walk(HERE);
  check("S11 one definition of WARN_AT/BLOCK_AT", owners, ["scripts/lib/pr-size.mjs"]);
}

console.log(`pr-size self-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
