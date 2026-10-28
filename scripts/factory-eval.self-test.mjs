#!/usr/bin/env node
// Self-test for scripts/factory-eval.mjs (R6-a: schema, select rules, prepare, grade). Plain node; exit 0
// when every check passes. Planted repos stand in for real history; no agent is ever run.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { WARN_AT } from "./lib/pr-size.mjs";
import * as FE from "./factory-eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "factory-eval.mjs"), "utf8");
const EVALS = path.join(HERE, "..", "evals", "factory");
let passed = 0;
let failed = 0;
// check(name, want, fn): fn may be async; a throw is reported as the got value, never a crash.
const check = async (name, want, fn) => {
  let got;
  try {
    got = await fn();
  } catch (e) {
    got = `threw: ${e instanceof Error ? e.message : e}`;
  }
  const same = JSON.stringify(got) === JSON.stringify(want);
  const detail = same ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
  console.log(`${same ? "  ok  " : "  FAIL"} ${name}${detail}`);
  if (same) passed += 1;
  else failed += 1;
};
delete process.env.DATABASE_URL;

const sh = (dir, ...a) => {
  const id = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
  const opts = { cwd: dir, encoding: "utf8", env: scrubbedGitEnv() };
  const r = spawnSync("git", [...id, "-c", "core.hooksPath=", ...a], opts);
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
/** Throwaway repo on master holding `files`; its own toplevel is proven before the first write. */
function plant(files) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evt-")));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  const commit = (msg) => (sh(dir, "add", "."), sh(dir, "commit", "-q", "-m", msg));
  try {
    sh(dir, "init", "-q", "-b", "master");
    const top = sh(dir, "rev-parse", "--show-toplevel").toLowerCase();
    if (top !== dir.replace(/\\/g, "/").toLowerCase())
      throw new Error(`planted repo is not its own toplevel (GIT_* leaked): ${dir}`);
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    commit("init");
  } catch (e) {
    cleanup();
    throw e;
  }
  return { dir, write, commit, git: (...a) => sh(dir, ...a), cleanup };
}
const mod = (v) => `export const f = () => ${v};\n`;
const hidden = `import { f } from "./x.mjs";\nif (f() !== 2) process.exit(1);\n`;
const base = { id: "acme-x", kind: "bug", risk: "amber", sourcePr: 1, brief: "f must return 2" };

// E1: the schema names the missing field.
const full = {
  ...base,
  baseSha: "a".repeat(40),
  hiddenTests: [{ path: "a.mjs", fromSha: "bbbbbbb" }],
};
await check("E1 a valid task has no errors", [], () => FE.validateTask(full));
await check("E1 a task missing a field is rejected, naming it", [true, true, true, true], () =>
  ["baseSha", "hiddenTests", "brief", "id"].map((field) => {
    const { [field]: _gone, ...rest } = full;
    const errs = FE.validateTask(rest);
    return errs.length === 1 && errs[0].startsWith(field);
  }),
);
await check(
  "E1 bad kind, empty hiddenTests, escaping path",
  [["kind"], ["hiddenTests"], ["hiddenTests"]],
  () => {
    const f = (o) => FE.validateTask({ ...full, ...o }).map((e) => e.split(":")[0]);
    return [
      f({ kind: "chore" }),
      f({ hiddenTests: [] }),
      f({ hiddenTests: [{ path: "../a.mjs", fromSha: "bbbbbbb" }] }),
    ];
  },
);

const repo = plant({ "x.mjs": mod(1) });
try {
  const baseSha = repo.git("rev-parse", "HEAD");
  repo.write("x.mjs", mod(2));
  repo.write("x.self-test.mjs", hidden);
  repo.commit("fix: x returns 2");
  const fix = repo.git("rev-parse", "HEAD");
  repo.write("y.self-test.mjs", "const = ;\n");
  repo.commit("test: y has a syntax error");
  const bad = repo.git("rev-parse", "HEAD");
  const task = { ...base, baseSha, hiddenTests: [{ path: "x.self-test.mjs", fromSha: fix }] };
  const trees = () => repo.git("worktree", "list").split("\n").length;
  const onTree = async (t, edit) => {
    const p = await FE.prepare(t, { repo: repo.dir });
    try {
      edit?.(p.tree);
      return await FE.grade(t, p.tree);
    } finally {
      p.cleanup();
    }
  };
  const put = (text) => (tree) => writeFileSync(path.join(tree, "x.mjs"), text);

  await check(
    "prepare writes BRIEF.md at baseSha, without the hidden test",
    [true, mod(1), 2],
    async () => {
      const p = await FE.prepare(task, { repo: repo.dir });
      try {
        const at = (f) => readFileSync(path.join(p.tree, f), "utf8").replace(/\r/g, "");
        return [at("BRIEF.md").includes(task.brief), at("x.mjs"), trees()];
      } finally {
        p.cleanup();
      }
    },
  );
  await check("E2 grade on the base tree is fail", "fail", async () => (await onTree(task)).result);
  await check("E3 grade with the fix applied is pass", "pass", async () => {
    return (await onTree(task, put(mod(2)))).result;
  });
  await check(
    "E4 a hidden test that cannot run is broken, with the reason",
    ["broken", true],
    async () => {
      const r = await onTree({ ...task, hiddenTests: [{ path: "y.self-test.mjs", fromSha: bad }] });
      return [r.result, /SyntaxError/.test(r.reason)];
    },
  );
  await check("a syntax error in the agent's code is a fail, not broken", "fail", async () => {
    return (await onTree(task, put("const = ;\n"))).result;
  });
  await check("the extra grade command decides once the tests pass", ["fail", "pass"], async () => {
    const t = (cmd) => onTree({ ...task, grade: ["node", "-e", cmd] }, put(mod(2)));
    return [(await t("process.exit(3)")).result, (await t("0")).result];
  });
  await check(
    "E5 no worktree left after a throw or an unreachable baseSha",
    [0, true],
    async () => {
      const before = trees();
      await onTree(task, () => {
        throw new Error("boom");
      }).catch(() => {});
      const lost = { ...task, baseSha: "f".repeat(40) };
      const msg = await FE.prepare(lost, { repo: repo.dir }).catch((e) => e.message);
      return [trees() - before, /not reachable/.test(msg)];
    },
  );
} finally {
  repo.cleanup();
}

// E10: inventory pin, select rules, live-tenant scan, and the shipped files.
await check(
  "E10 imports R4's runner and R3's WARN_AT, copies neither",
  [true, true, false, true],
  () => [
    /import \{[^}]*\bdefaultRun\b[^}]*\} from "\.\/fix-revert-probe\.mjs"/.test(SRC),
    /import \{[^}]*\bWARN_AT\b[^}]*\} from "\.\/lib\/pr-size\.mjs"/.test(SRC),
    /const JEST\b|WARN_AT\s*=/.test(SRC),
    FE.SELECT_MAX_LINES === WARN_AT,
  ],
);
const file = (p, additions) => ({ path: p, additions, deletions: 0 });
const pr = (o = {}) => ({
  ...{ number: 9, title: "fix: acme rounding", body: "", reworkOf: null },
  files: [file("src/a.ts", 5), file("src/a.spec.ts", 9)],
  ...o,
});
await check("select keeps a small PR that adds tests", true, () => FE.keepCandidate(pr()).keep);
for (const [why, o, reason] of [
  ["no tests", { files: [file("src/a.ts", 5)] }, /tests/],
  ["rework", { title: "fix: rework of #12 rounding" }, /rework/],
  ["too many lines", { files: [file("src/a.spec.ts", WARN_AT + 1)] }, /WARN_AT/],
  ["a live tenant", { body: "SMOKE_TENANT_SLUG=zzlive" }, /live-tenant/],
]) {
  await check(
    `select drops a PR with ${why}, never printing the identifier`,
    [false, true, false],
    () => {
      const k = FE.keepCandidate(pr(o));
      return [k.keep, reason.test(k.reason), k.reason.includes("zzlive")];
    },
  );
}
await check("live-tenant scan: placeholders and test slugs pass, others hit", [0, 0, 0, 1, 1], () =>
  [
    'slug: "acme"',
    'slug: "e2e-foo"',
    "SMOKE_TENANT_SLUG=test",
    "SMOKE_TENANT_SLUG=zzlive",
    'tenantId: "123e4567-e89b-12d3-a456-426614174000"',
  ].map((s) => FE.liveTenantHits(s)),
);
await check(
  "E10 every task file passes the schema; the example is skipped",
  [[], true, [], false],
  () => {
    const dir = path.join(EVALS, "tasks");
    const all = FE.loadTasks(dir, { includeExample: true });
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const dirty = files.filter((f) => FE.liveTenantHits(readFileSync(path.join(dir, f), "utf8")));
    return [
      all.errors,
      all.tasks.length === files.length,
      dirty,
      FE.loadTasks(dir).tasks.some((t) => t.example),
    ];
  },
);

console.log(`factory-eval self-test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
