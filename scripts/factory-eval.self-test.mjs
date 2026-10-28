#!/usr/bin/env node
// Self-test for scripts/factory-eval.mjs (schema, select rules, prepare, grade, cleanup, budget, sample, report, run).
// Plain node; exit 0 when every check passes. Planted repos stand in for history; only the free stub arm runs.
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
  await check(
    "cleanup unlinks a link the agent planted (its target survives) and the tree is really gone",
    [true, false, true],
    async () => {
      const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evo-")));
      writeFileSync(path.join(outside, "keep.txt"), "keep\n");
      try {
        const p = await FE.prepare(task, { repo: repo.dir });
        symlinkSync(outside, path.join(p.tree, "planted"), "junction");
        mkdirSync(path.join(p.tree, "v", ".git"), { recursive: true }); // only the root .git is skipped
        symlinkSync(outside, path.join(p.tree, "v", ".git", "planted"), "junction");
        const ok = FE.cleanupTree(p.tree, { repo: repo.dir });
        return [ok, existsSync(p.tree), existsSync(path.join(outside, "keep.txt"))];
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
  await check("a failed prepare also reports a failed cleanup", [true, true], async () => {
    const dir = path.join(realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-eval-"))), "wt");
    const unlock = () =>
      spawnSync("git", ["worktree", "unlock", dir], { cwd: repo.dir, env: scrubbedGitEnv() });
    const get = () => (unlock(), new URL("x")); // throws; cleanup then finds no lock and throws too
    const t = Object.defineProperty({ ...task }, "brief", { get });
    try {
      const msg = await FE.prepare(t, { repo: repo.dir, dir }).catch((e) => e.message);
      return [/Invalid URL/.test(msg), /cleanup also failed/.test(msg)];
    } finally {
      repo.git("worktree", "lock", "--reason", "rf-eval", dir);
      FE.cleanupTree(dir, { repo: repo.dir }); // also removes the empty rf-eval- parent
    }
  });
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

  // E5/E6/E8: run, with the stub arm only.
  const arms = FE.loadArms();
  const env = { EVAL_STUB_SHA: fix, EVAL_STUB_PATHS: "x.mjs" };
  const go = (o) => FE.runEval({ tasks: [task], armName: "stub", arms, repo: repo.dir, ...o });
  const before = trees();
  await check(
    "E5 a throw inside run: no worktree left, the run is recorded broken",
    ["broken", true, 0, true],
    async () => {
      const out = await go({
        k: 1,
        extraEnv: env,
        gradeFn: () => {
          throw new Error("boom");
        },
      });
      const r = out.records[0];
      return [r.result, /boom/.test(r.reason), trees() - before, marker()];
    },
  );
  await check(
    "E6 stub arm at k=3: three passes, pass^3 = 1, the reported cost, nothing left behind",
    [["pass", "pass", "pass"], true, 1, [0.25, 0.25, 0.25], 0],
    async () => {
      const out6 = await go({ k: 3, extraEnv: env });
      const passes = out6.records.filter((r) => r.result === "pass").length;
      const costs = out6.records.map((r) => r.costUsd);
      return [out6.records.map((r) => r.result), passes === 3, passes / 3, costs, trees() - before];
    },
  );
  await check(
    "a dollar-cap overrun is flagged; a wall-clock overrun is broken",
    [true, "broken"],
    async () => {
      const dear = { stub: { ...arms.stub, capUsd: 0.1 } };
      const slow = {
        stub: { ...arms.stub, cmd: ["node", "-e", "setTimeout(()=>{},30000)"], timeoutSec: 1 },
      };
      const a = await go({ k: 1, extraEnv: env, arms: dear });
      const b = await go({ k: 1, arms: slow, env: { EVAL_ALLOW_REAL_ARM: "1" } });
      return [a.records[0].overCap, b.records[0].result];
    },
  );
  await check(
    "run refuses an arm that is not the stub unless EVAL_ALLOW_REAL_ARM is set",
    [true, 0, 0],
    async () => {
      const real = { real: { cmd: ["node", "-e", "process.exit(9)"], estUsd: 1, capUsd: 1 } };
      const out = await go({ armName: "real", arms: real, k: 1, env: {} });
      const zero = await go({
        armName: "real",
        arms: real,
        k: 1,
        env: { EVAL_ALLOW_REAL_ARM: "0" },
      });
      const refused = [out, zero].every((o) => /EVAL_ALLOW_REAL_ARM/.test(o.refused ?? ""));
      return [refused, out.records.length + zero.records.length, trees() - before];
    },
  );
  const twenty = Array.from({ length: 20 }, (_, i) => ({ ...task, id: `acme-${i}` }));
  const dollar = { stub: { ...arms.stub, capUsd: 1 } };
  await check(
    "E8 3 x 20 x $1 exceeds the default $40: refused with the total, before any spawn",
    [true, 0, 0],
    async () => {
      const out = await go({ tasks: twenty, arms: dollar, k: 3, env: {} });
      return [/\$60\.00/.test(out.refused), out.records.length, trees() - before];
    },
  );
  await check("E8 --budget 80 and EVAL_BUDGET_USD=70 allow it", [true, true, false], () => {
    const g = (o) => FE.checkBudget({ k: 3, taskCount: 20, capUsd: 1, env: {}, ...o }).ok;
    return [g({ budget: 80 }), g({ env: { EVAL_BUDGET_USD: "70" } }), g({})];
  });
  await check(
    "mid-run: a run that overspends stops the next one when spent + cap would pass the budget",
    ["budget used up mid-run", 1, 2.5],
    async () => {
      const cmd = ["node", "-e", "console.log(JSON.stringify({total_cost_usd:2.5}))"];
      const pricey = { p: { cmd, capUsd: 1, timeoutSec: 60 } };
      const allow = { EVAL_ALLOW_REAL_ARM: "1" };
      const out = await go({ armName: "p", arms: pricey, k: 3, budget: 3, env: allow });
      return [out.stopped, out.records.length, out.records[0]?.costUsd];
    },
  );
  await check("a cleanup that throws is recorded on the run, not lost", [1, true, 0], async () => {
    const prepareFn = async (t, o) => {
      const p = await FE.prepare(t, o);
      const cleanup = () => {
        p.cleanup();
        throw new Error("rm failed");
      };
      return { tree: p.tree, cleanup };
    };
    const out = await go({ k: 1, extraEnv: env, prepareFn });
    return [out.records.length, /rm failed/.test(out.records[0]?.reason), trees() - before];
  });
  await check(
    "money compares in cents: 3 x $0.10 fits a $0.30 budget, before and during the run",
    [true, 3, undefined],
    async () => {
      const dime = {
        d: { cmd: ["node", "-e", "console.log('{\"total_cost_usd\":0.1}')"], capUsd: 0.1 },
      };
      const allow = { EVAL_ALLOW_REAL_ARM: "1" };
      const ok = FE.checkBudget({ k: 3, taskCount: 1, capUsd: 0.1, budget: 0.3, env: {} }).ok;
      const out = await go({ armName: "d", arms: dime, k: 3, budget: 0.3, env: allow });
      return [ok, out.records.length, out.stopped];
    },
  );
  await check(
    "the arm's process never inherits the runner's own EVAL_ settings",
    "undefined",
    async () => {
      const probe = path.join(repo.dir, "probe.txt");
      const cmd = [
        "node",
        "-e",
        "require('fs').writeFileSync(process.argv[1], String(process.env.EVAL_PROBE))",
        probe,
      ];
      process.env.EVAL_PROBE = "leak";
      try {
        await go({
          armName: "p",
          arms: { p: { cmd, capUsd: 1 } },
          k: 1,
          env: { EVAL_ALLOW_REAL_ARM: "1" },
        });
      } finally {
        delete process.env.EVAL_PROBE;
      }
      return readFileSync(probe, "utf8");
    },
  );
  await check("a cap of 0, below 0 or not a number is refused", [false, false, false], () =>
    [0, -1, "x"].map((capUsd) => FE.checkBudget({ k: 1, taskCount: 1, capUsd, env: {} }).ok),
  );
  await check(
    "total_cost_usd must be a finite number >= 0; anything else is unknown",
    [null, null, null, null, null, 0.3],
    () =>
      [null, '""', "-1", '"0.5"', "1e999", "0.3"].map((v) =>
        FE.parseCost(`{"total_cost_usd":${v}}`),
      ),
  );
  await check(
    "the agent sees only the stub's EVAL_ variables",
    { EVAL_STUB_SHA: "a", EVAL_STUB_PATHS: "x" },
    () =>
      FE.agentEnv({
        EVAL_STUB_SHA: "a",
        EVAL_STUB_PATHS: "x",
        EVAL_LIVE_DENYLIST: "/secret",
        EVAL_ALLOW_REAL_ARM: "1",
        PATH: "p",
      }),
  );
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

// Results land under local-assets/evals/<run-id>/ and that path is gitignored.
const tmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evr-")));
try {
  await check(
    "results are saved under local-assets/evals/<run-id>/, which is gitignored",
    [true, true, 0],
    () => {
      const f = FE.saveRun(tmp, "run-1", [{ taskId: "t1" }]);
      const rel = path.relative(tmp, f).split(path.sep).join("/");
      const top = path.join(HERE, "..");
      const git = ["check-ignore", "-q", "local-assets/evals/run-1/results.jsonl"];
      return [
        rel === "local-assets/evals/run-1/results.jsonl",
        JSON.parse(readFileSync(f, "utf8")).taskId === "t1",
        spawnSync("git", git, { cwd: top, env: scrubbedGitEnv() }).status,
      ];
    },
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const cli = (...a) =>
  spawnSync("node", [path.join(HERE, "factory-eval.mjs"), ...a], { encoding: "utf8" });
// E7: report --vs over two result files on the same four tasks.
const rtmp = realpathSync.native(mkdtempSync(path.join(tmpdir(), "rf-evr-")));
try {
  const rec = (taskId, run, ok, costUsd, wallSec, result = ok ? "pass" : "fail") => ({
    taskId,
    arm: "same-arm",
    run,
    result,
    costUsd,
    wallSec,
  });
  const plan = { t1: [2, 0], t2: [2, 1], t3: [0, 2], t4: [2, 2] }; // passes of 2 runs: [cand, base]
  const lines = (i, cost) =>
    Object.entries(plan).flatMap(([t, p]) =>
      [0, 1].map((r) => rec(t, r, r < p[i], cost, 10 * (r + 1))),
    );
  const save = (name, rows) => {
    const f = path.join(rtmp, name);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n"));
    return f;
  };
  const fa = save("cand.jsonl", lines(0, 3));
  const fb = save("base/results.jsonl", lines(1, 1));
  const R = () => FE.report(FE.readResults([fa, path.dirname(fb)]), { vs: "base" });
  await check(
    "E7 won 2, lost 1, tied 1 (two runs of one arm, told apart by file)",
    [2, 1, 1],
    () => {
      const v = R().vs.against[0];
      return [v.won, v.lost, v.tied];
    },
  );
  await check("E7 pass^k per task", [true, true, false, true], () =>
    R()
      .rows.filter((r) => r.run === "cand")
      .map((r) => r.passK),
  );
  await check("pass@1 is exact for k = 3 and shown with 2 decimals", [2 / 3, true], () => {
    const rs = [rec("t", 0, true, 1, 1), rec("t", 1, true, 1, 1), rec("t", 2, false, 1, 1)];
    const rep = FE.report(rs);
    return [rep.rows[0].passAt1, /0\.67/.test(FE.formatReport(rep))];
  });
  await check("a null cost is left out of the mean and counted as unknown", [2, 1, true], () => {
    const rs = [rec("t", 0, true, 1, 1), rec("t", 1, true, 3, 1), rec("t", 2, true, null, 1)];
    const rep = FE.report(rs);
    return [rep.runs[0].meanCost, rep.runs[0].unknownCost, /1 unknown/.test(FE.formatReport(rep))];
  });
  await check("broken is counted on its own line, not folded into fail", [1, true], () => {
    const rep = FE.report([rec("t", 0, true, 1, 1), rec("t", 1, false, 1, 1, "broken")]);
    return [rep.rows[0].broken, /^broken/m.test(FE.formatReport(rep))];
  });
  await check(
    "a malformed line is skipped and counted; its text is never printed",
    [1, false],
    () => {
      const rs = FE.readResults([
        save("bad.jsonl", [rec("t", 0, true, 1, 1), "{zzsecret not json"]),
      ]);
      return [rs.malformed, FE.formatReport(FE.report(rs), rs.malformed).includes("zzsecret")];
    },
  );
  await check("the report text names pass^k, pass@1 and won/lost/tied", [true, true, true], () => {
    const text = FE.formatReport(R());
    return [/pass\^k/.test(text), /pass@1/.test(text), /won 2, lost 1, tied 1/.test(text)];
  });
  await check("report --json prints the report as JSON", [true], () => {
    const out = spawnSync("node", [path.join(HERE, "factory-eval.mjs"), "report", fa, "--json"], {
      encoding: "utf8",
    });
    return [Array.isArray(JSON.parse(out.stdout).rows)];
  });

  // R6-b3 review: broken repeats, validated results, pass^k needs k runs, run labels.
  const set = (runId, plan, x) =>
    Object.entries(plan).flatMap(([t, rs]) =>
      rs.map((r, i) => ({ ...rec(t, i, r === "pass", 1, 1, r), runId, ...x })),
    );
  const P3 = ["pass", "pass", "pass"];
  const vsv = (r) => Object.values(r.vs.against[0]).slice(1); // won, lost, tied
  const cell = (r, run, t) => r.rows.find((x) => x.run === run && x.taskId === t);
  await check("broken repeats are left out", [true, 1, [0, 0, 1], 1, true], () => {
    const A = set("A", { t1: ["pass", "pass", "broken"], t2: Array(3).fill("broken") });
    const r = FE.report([...A, ...set("B", { t1: P3, t2: P3 })], { vs: "B" });
    const a = cell(r, "A", "t1");
    return [a.passK, a.passAt1, vsv(r), r.runs[0].tasks, /n\/a/.test(FE.formatReport(r))];
  });
  await check("an incomplete task is never pass^k", [false, false, [0, 1, 1], false, false], () => {
    const A = set("A", { t1: ["pass", "pass"], t2: P3, t9: P3 });
    const r = FE.report([...A, ...set("B", { t1: ["pass", "fail", "fail"], t2: P3 })], { vs: "B" });
    const a = cell(r, "A", "t1");
    const c = FE.report(set("C", { t1: ["pass", "pass"] }, { k: 3 })).rows[0];
    return [a.passK, a.complete, vsv(r), cell(r, "B", "t1").passK, c.passK];
  });
  await check("bad ids, results, costs and times are skipped", [2, 7, false, 1, true], () => {
    const line = (o) => JSON.stringify({ taskId: "t9", result: "pass", ...o });
    const bad = [{ costUsd: "5" }, { wallSec: "x" }, { costUsd: -1 }, { taskId: "a\u001b[31m" }];
    bad.push({ taskId: "a\nb" }, { result: "wat" }, { result: undefined });
    const ok = [
      { taskId: "t1", costUsd: 1 },
      { taskId: "t2", costUsd: null },
    ];
    const rs = FE.readResults([save("val.jsonl", [...ok, ...bad].map(line))]);
    const f = FE.report(rs);
    const text = FE.formatReport(f, rs.malformed);
    return [rs.length, rs.malformed, /NaN/.test(text), f.runs[0].meanCost, /skipped 7 /.test(text)];
  });
  const t0 = rec("t", 0, true, 1, 1);
  const one = save("x/run1/results.jsonl", [t0]);
  const two = save("y/run1/results.jsonl", [{ ...t0, result: "fail" }]);
  const mix = save("mix.jsonl", [t0, { ...t0, arm: "b" }]);
  const msg = (p) =>
    Promise.resolve(p)
      .then(FE.readResults)
      .catch((e) => e.message);
  await check("a label used twice, or two arms in a file, is refused", [true, true], async () => [
    (await msg([one, two])).includes(`${one} and ${two}`),
    /more than one arm/.test(await msg([mix])),
  ]);
  await check("--vs also listed reads once; --vs naming no run exits 2", [2, 2, 2], () => {
    const rows = JSON.parse(cli("report", fa, fb, "--vs", fa, "--json").stdout).rows;
    const exit = (v) => cli("report", fa, "--vs", v).status;
    return [Math.max(...rows.map((r) => r.runs)), exit(save("empty.jsonl", ["x"])), exit(rtmp)];
  });
} finally {
  rmSync(rtmp, { recursive: true, force: true });
}

// E9: seeded sample, kinds in proportion to the pool.
const mk = (bugs, feats) =>
  [...Array(bugs).fill("bug"), ...Array(feats).fill("feature")].map((kind, i) => ({
    ...base,
    id: `acme-${kind}-${i}`,
    kind,
    risk: ["green", "amber", "red"][i % 3],
  }));
const pool = mk(10, 10);
const ids = (n, seed) => FE.sampleTasks(pool, n, seed).map((t) => t.id);
await check("E9 --sample 6 --seed 1 twice gives the same 6 ids", [true, 6], () => {
  const a = ids(6, 1);
  return [JSON.stringify(a) === JSON.stringify(ids(6, 1)), new Set(a).size];
});
await check("E9 a 15-bug / 5-feature pool at n = 8 gives 6 bugs and 2 features", [6, 2], () => {
  const got = FE.sampleTasks(mk(15, 5), 8, 3);
  return ["bug", "feature"].map((k) => got.filter((t) => t.kind === k).length);
});
await check("E9 both kinds are present at n = 2, even in a lopsided pool", [2, 2], () => [
  new Set(FE.sampleTasks(pool, 2, 7).map((t) => t.kind)).size,
  new Set(FE.sampleTasks(mk(19, 1), 2, 7).map((t) => t.kind)).size,
]);
await check("E9 risks rotate inside a kind", [3], () => [
  new Set(FE.sampleTasks(mk(9, 0), 3, 5).map((t) => t.risk)).size,
]);
await check("E9 the seed changes the ids; n caps at the pool", [true, 20], () => {
  const green = mk(9, 0).filter((t) => t.risk === "green");
  const ids = Array.from({ length: 30 }, (_, i) => FE.sampleTasks(green, 1, i + 1)[0].id);
  return [new Set(ids).size > 1, FE.sampleTasks(pool, 25, 1).length];
});
await check("E9 --sample must be a whole number of 1 or more", [true], () => [
  ["0", "-1", "2.5", "abc"].every((n) => {
    const r = cli("run", "--arm", "stub", "--sample", n);
    return r.status === 2 && /--sample/.test(r.stderr);
  }),
]);

await check(
  "arms file: a stub arm and one real template; the stub is free",
  [["claude-sonnet", "stub"], "node", "claude", ["number", "number", "number"]],
  () => {
    const a = FE.loadArms();
    const nums = ["estUsd", "capUsd", "timeoutSec"].map((k) => typeof a.stub[k]);
    return [Object.keys(a).sort(), a.stub.cmd[0], a["claude-sonnet"].cmd[0], nums];
  },
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
