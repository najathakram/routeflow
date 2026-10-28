#!/usr/bin/env node
// Self-test for scripts/factory-eval.mjs (schema, select rules, prepare, grade, cleanup).
// Plain node; exit 0 when every check passes. Planted repos stand in for history; no agent runs.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  const r = spawnSync("git", [...id, "-c", "core.hooksPath=", ...a], {
    cwd: dir,
    encoding: "utf8",
    env: scrubbedGitEnv(),
  });
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
await check("E1 a trailing .., node_modules or a drive prefix is rejected", [1, 1, 1], () =>
  ["a/..", "node_modules/x.mjs", "C:x.mjs"].map(
    (p) => FE.validateTask({ ...full, hiddenTests: [{ path: p, fromSha: "bbbbbbb" }] }).length,
  ),
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
  repo.write("z.self-test.mjs", 'console.log("z.self-test.mjs:1");\nconsole.log("SyntaxError");\n');
  repo.commit("test: z passes but prints the word");
  const zSha = repo.git("rev-parse", "HEAD");
  repo.write("w.spec.ts", "// a type-checked test\n");
  repo.commit("test: w spec");
  const wSha = repo.git("rev-parse", "HEAD");
  repo.write("node_modules/marker.txt", "keep\n"); // untracked: prepare must junction it, cleanup must spare it
  const marker = () => existsSync(path.join(repo.dir, "node_modules", "marker.txt"));
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
  await check("a passing test that prints SyntaxError is a pass", "pass", async () => {
    return (await onTree({ ...task, hiddenTests: [{ path: "z.self-test.mjs", fromSha: zSha }] }))
      .result;
  });
  await check(
    "grade refuses a tree prepare did not make, untouched",
    [true, "keep\n"],
    async () => {
      repo.write("x.self-test.mjs", "keep\n");
      const msg = await FE.grade(task, repo.dir).catch((e) => e.message);
      const left = readFileSync(path.join(repo.dir, "x.self-test.mjs"), "utf8");
      repo.git("checkout", "--", "x.self-test.mjs");
      return [/not a prepared eval tree/.test(msg), left];
    },
  );
  await check(
    "E5 no worktree left after a throw or an unreachable baseSha; the caller's node_modules survives",
    [0, true, true],
    async () => {
      const before = trees();
      await onTree(task, () => {
        throw new Error("boom");
      }).catch(() => {});
      const lost = { ...task, baseSha: "f".repeat(40) };
      const msg = await FE.prepare(lost, { repo: repo.dir }).catch((e) => e.message);
      return [trees() - before, /not reachable/.test(msg), marker()];
    },
  );
  await check(
    "cleanup <tree> unlinks the junction, removes the tree and its temp parent, spares node_modules",
    [true, true, false, false, true, 0],
    async () => {
      const before = trees();
      const p = await FE.prepare(task, { repo: repo.dir });
      const linked = lstatSync(path.join(p.tree, "node_modules")).isSymbolicLink();
      const ok = FE.cleanupTree(p.tree, { repo: repo.dir });
      const parent = path.dirname(p.tree);
      return [linked, ok, existsSync(p.tree), existsSync(parent), marker(), trees() - before];
    },
  );
  await check(
    "cleanup refuses a directory that is not a linked worktree",
    `threw: ${repo.dir} is not a linked worktree`,
    () => FE.cleanupTree(repo.dir, { repo: repo.dir }),
  );
  await check(
    "cleanup refuses a lane's or a probe's worktree (locked otherwise, or unlocked), even beside an eval tree",
    [true, true, true, true, true],
    async () => {
      const lane = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evl-")));
      const wt = path.join(lane, "wt");
      repo.git("worktree", "add", "--detach", wt, "HEAD");
      const evalTree = await FE.prepare(task, { repo: repo.dir }); // an rf-eval lock exists elsewhere
      try {
        writeFileSync(path.join(wt, "BRIEF.md"), "lane\n");
        writeFileSync(path.join(wt, "wip.txt"), "keep\n");
        const refused = (fn) => {
          try {
            return fn() === false;
          } catch (err) {
            return /not a tree prepare made/.test(err.message);
          }
        };
        const open = refused(() => FE.cleanupTree(wt, { repo: repo.dir }));
        repo.git("worktree", "lock", "--reason", "lane in use", wt);
        const locked = refused(() => FE.cleanupTree(wt, { repo: repo.dir }));
        const still = repo.git("worktree", "list", "--porcelain").includes("locked lane in use");
        repo.git("worktree", "unlock", wt);
        repo.git("worktree", "lock", "--reason", "rf-probe", wt);
        const probe = refused(() => FE.cleanupTree(wt, { repo: repo.dir }));
        return [open, locked, existsSync(path.join(wt, "wip.txt")), still, probe];
      } finally {
        evalTree.cleanup();
        spawnSync("git", ["worktree", "unlock", wt], { cwd: repo.dir, env: scrubbedGitEnv() });
        repo.git("worktree", "remove", "--force", wt);
        rmSync(lane, { recursive: true, force: true });
      }
    },
  );
  // A lane can lock its own tree "rf-eval"; the lock alone must not make cleanup remove it.
  const siblingLockedAsEval = async (token) => {
    const lane = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evl-")));
    const wt = path.join(lane, "wt");
    repo.git("worktree", "add", "--detach", wt, "HEAD");
    repo.git("worktree", "lock", "--reason", "rf-eval", wt);
    try {
      if (token) {
        const gitDir = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-dir"], {
          cwd: wt,
          encoding: "utf8",
          env: scrubbedGitEnv(),
        }).stdout.trim();
        writeFileSync(path.join(gitDir, "rf-eval-owner"), token);
      }
      writeFileSync(path.join(wt, "wip.txt"), "keep\n");
      let msg = "";
      try {
        FE.cleanupTree(wt, { repo: repo.dir, runId: FE.RUN_ID });
      } catch (err) {
        msg = err.message;
      }
      const still = repo.git("worktree", "list", "--porcelain").includes("locked rf-eval");
      return [
        msg.includes(wt) && /owner token/.test(msg),
        existsSync(path.join(wt, "wip.txt")),
        still,
      ];
    } finally {
      spawnSync("git", ["worktree", "unlock", wt], { cwd: repo.dir, env: scrubbedGitEnv() });
      repo.git("worktree", "remove", "--force", wt);
      rmSync(lane, { recursive: true, force: true });
    }
  };
  await check(
    "cleanup throws for a sibling locked rf-eval with NO owner token, leaving it locked",
    [true, true, true],
    () => siblingLockedAsEval(null),
  );
  await check(
    "cleanup throws for an owner token with the wrong run id, leaving the tree",
    [true, true, true],
    () => siblingLockedAsEval("rf-eval-owner v1 run=someone-else pid=1 at=2026-10-28T00:00:00Z\n"),
  );
  await check(
    "cleanup removes a tree whose token matches this run, and a sweep accepts any parsable token",
    [true, false, true, false],
    async () => {
      const a = await FE.prepare(task, { repo: repo.dir });
      const okRun = FE.cleanupTree(a.tree, { repo: repo.dir, runId: FE.RUN_ID });
      const b = await FE.prepare(task, { repo: repo.dir });
      const okSweep = FE.cleanupTree(b.tree, { repo: repo.dir }); // later sweep: run id unknown
      return [okRun, existsSync(a.tree), okSweep, existsSync(b.tree)];
    },
  );
  await check(
    "cleanup unlinks a link the agent planted (its target survives) and the tree is really gone",
    [true, false, true],
    async () => {
      const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evo-")));
      writeFileSync(path.join(outside, "keep.txt"), "keep\n");
      try {
        const p = await FE.prepare(task, { repo: repo.dir });
        symlinkSync(outside, path.join(p.tree, "planted"), "junction");
        const ok = FE.cleanupTree(p.tree, { repo: repo.dir });
        return [ok, existsSync(p.tree), existsSync(path.join(outside, "keep.txt"))];
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
  await check("cleanup keeps the parent of a --dir tree", [true, false], async () => {
    const parent = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evp-")));
    try {
      const p = await FE.prepare(task, { repo: repo.dir, dir: path.join(parent, "wt") });
      p.cleanup();
      return [existsSync(parent), existsSync(p.tree)];
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
  const ts = "w.spec.ts:3:5 - error TS2322: Type 'string' is not assignable to type 'number'.\n";
  const gradeWith = async (output, status = 1) => {
    const t = { ...task, hiddenTests: [{ path: "w.spec.ts", fromSha: wSha }] };
    const p = await FE.prepare(t, { repo: repo.dir });
    try {
      return await FE.grade(t, p.tree, { run: () => ({ status, output }) });
    } finally {
      p.cleanup();
    }
  };
  await check(
    "a .spec.ts that fails on TS diagnostics with no test results is broken; with results it is a fail",
    [["broken", true], "fail", "fail"],
    async () => {
      const none = await gradeWith(`${ts}Test Suites: 1 failed, 1 total\nTests:       0 total\n`);
      const some = await gradeWith(`${ts}Tests:       1 failed, 1 total\n`);
      return [
        [none.result, /TS|type/i.test(none.reason)],
        some.result,
        (await gradeWith("")).result,
      ];
    },
  );
  const tsc = (file, code) =>
    `\x1b[96m${file}\x1b[0m:\x1b[93m3\x1b[0m:\x1b[93m1\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m ${code}: \x1b[0m'}' expected.\n`;
  await check(
    "coloured ts-jest output: the hidden spec's own TS error is broken, the agent's file's is a fail",
    ["broken", "fail"],
    async () => {
      const none = "Test Suites: 1 failed, 1 total\nTests:       0 total\n";
      return [
        (await gradeWith(tsc("w.spec.ts", "TS2322") + none)).result,
        (await gradeWith(tsc("src/foo.ts", "TS1005") + none)).result,
      ];
    },
  );
  await check(
    "same file name elsewhere is not the hidden test: TS and SyntaxError both grade fail; mixed errors fail",
    ["fail", "fail", "fail"],
    async () => {
      const none = "Tests:       0 total\n";
      return [
        (await gradeWith(tsc("src/legacy/w.spec.ts", "TS1005") + none)).result,
        (await gradeWith("neww.spec.ts:3\nSyntaxError: Unexpected token\n")).result,
        (await gradeWith(tsc("w.spec.ts", "TS2322") + tsc("src/foo.ts", "TS1005") + none)).result,
      ];
    },
  );
  await check("a null status says timed out or could not start", true, async () => {
    return /timed out or could not start/.test((await gradeWith("", null)).reason);
  });

  await check(
    "a malformed landings row is skipped and counted, never echoed",
    [2, [7, 8], false],
    () => {
      const f = path.join(repo.dir, "landings.jsonl");
      const good = (pr) => JSON.stringify({ pr, computedAt: "2026-01-01", mergedAt: "2026-01-02" });
      writeFileSync(f, [good(7), "{zzsecret not json", good(8), '{"no":"pr"}'].join("\n"));
      const r = FE.readLandings(f);
      return [r.malformed, [...r.rows.keys()], JSON.stringify(r).includes("zzsecret")];
    },
  );
} finally {
  repo.cleanup();
}

await check(
  "select warns when gh returns exactly 200 PRs (possible truncation)",
  [true, null],
  () => [/200/.test(FE.truncationWarning(200)), FE.truncationWarning(199)],
);

// E10: inventory pin, select rules, live-tenant scan, and the shipped files.
await check(
  "E10 imports R4's runner and R3's WARN_AT, copies neither; no runner table under any name",
  [true, true, false, true, false],
  () => [
    /import \{[^}]*\bdefaultRun\b[^}]*\} from "\.\/fix-revert-probe\.mjs"/.test(SRC),
    /import \{[^}]*\bWARN_AT\b[^}]*\} from "\.\/lib\/pr-size\.mjs"/.test(SRC),
    /const JEST\b|WARN_AT\s*=/.test(SRC),
    FE.SELECT_MAX_LINES === WARN_AT,
    // a copied runner table spawns the test runner itself, whatever it is called
    /jest/i.test(SRC),
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
