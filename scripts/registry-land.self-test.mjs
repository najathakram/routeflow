#!/usr/bin/env node
/**
 * Self-test for `sync` on origin/master and `registry:land` (B1-b2a, SPEC v3.2 "Sync" + "Claims" steps
 * 0-1, cases L1-L6 of the round-3 MUST "--rescan on a missing anchor").
 *
 * A planted routeflow repo (bare + main checkout) with commits that mention B1 stands in for the real
 * repo (BUGS_SYNC_REPO, honoured only under BUGS_SELF_TEST=1); the register is the shared bare-repo
 * fixture. Everything runs the real scripts in clone mode. Run: `node scripts/registry-land.self-test.mjs`.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { fixture, git } from "./lib/registry-fixture.mjs";
import * as rr from "./lib/registry-root.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUGS = join(ROOT, "scripts", "campaign", "bugs.mjs");
const LAND = join(ROOT, "scripts", "registry-land.mjs");
const GAP = "anchor gap: run `bugs.mjs sync --rescan` with a wider window";
const fx = fixture("rf-regland-");
const { tmp, bare, check, section, env, showOrigin } = fx;
const fwd = (p) => p.replaceAll("\\", "/");

fx.world();
const A = fx.clone("a");
const B = fx.clone("b");
const rf = join(tmp, "rf");
const rf2 = join(tmp, "rf2");
git(tmp, "init", "--bare", "--initial-branch=master", join(tmp, "rf.git"));
git(tmp, "clone", join(tmp, "rf.git"), "rf");
const commit = (dir, msg) => {
  appendFileSync(join(dir, "f.txt"), `${msg}\n`);
  git(dir, "add", "f.txt");
  git(dir, "commit", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
};
const c0 = commit(rf, "chore: init");
const c1 = commit(rf, "feat: first (B1)");
const c2 = commit(rf, "fix: B1 again");
commit(rf, "chore: nothing");
const c4 = commit(rf, "fix: B1 follow-up");
git(rf, "push", "origin", "HEAD:master");
git(tmp, "clone", join(tmp, "rf.git"), "rf2");
const tip = commit(rf2, "docs: tip");
git(rf2, "push", "origin", "HEAD:master");
git(rf, "fetch", "origin");
git(rf, "reset", "--hard", "origin/master");
git(rf, "update-ref", "refs/remotes/origin/master", c4); // origin/master is stale: the fetch must fix it

const an = (n) => join(tmp, `anchor-${n}.json`);
// Stands in for `campaign-check.mjs --landing` (REGISTRY_LAND_CHECK_CMD, honoured only under
// BUGS_SELF_TEST=1). It logs what it saw to STUB_LOG and fails on STUB_FAIL=1.
const stub = join(tmp, "check-stub.mjs");
writeFileSync(
  stub,
  `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const e = process.env;
const led = (e.CAMPAIGN_CHECK_STATUS_DIR ?? "") + "/F01.jsonl";
if (e.STUB_LOG)
  appendFileSync(
    e.STUB_LOG,
    JSON.stringify({
      args: process.argv.slice(2),
      status: e.CAMPAIGN_CHECK_STATUS_DIR,
      code: e.CAMPAIGN_CHECK_CODE_ROOT,
      leak: e.GIT_AUTHOR_NAME ?? null,
      mode: e.RF_VERIFY_MODE ?? null,
      proven: existsSync(led) && readFileSync(led, "utf8").includes('"state":"proven"'),
    }) + "\\n",
  );
if (e.STUB_FAIL === "1") {
  console.error("stub: F01 B1 refused, no proof in the reports");
  process.exit(1);
}
if (e.STUB_HANG === "1") await new Promise((r) => setTimeout(r, 8000)); // outlives the timeout
`,
);
const regEnv = (dir, anchor, extra = {}) =>
  env({
    RF_REGISTRY_DIR: dir,
    RF_REGISTRY_MODE_TEST: "clone",
    BUGS_SELF_TEST: "1",
    BUGS_SYNC_REPO: rf,
    BUGS_SYNC_STATE: anchor,
    REGISTRY_LAND_CHECK_CMD: stub,
    ...extra,
  });
const run = (script, args, e, cwd = tmp) =>
  spawnSync("node", [script, ...args], { encoding: "utf8", env: e, cwd });
const land = (args, e) => run(LAND, args, e);
const sumOf = (r) => {
  const m = /events (\d+), claims (\d+)(?:, skipped (\d+))?, scan (\w+), anchor (\w+) → (\w+)/.exec(
    r.stdout,
  );
  return (
    m && {
      events: +m[1],
      claims: +m[2],
      skipped: +(m[3] ?? 0),
      scan: m[4],
      before: m[5],
      after: m[6],
    }
  );
};
const writeJson = (name, v) => {
  const p = join(tmp, name);
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  return p;
};
const okClaims = [
  { id: "B1", action: "prove", pr: 3901, proof: "REG-B1 jest: the follow-up rounds to cents" },
  { id: "B1", action: "note", text: "landed with the follow-up" },
];
const okFile = writeJson("ok.json", okClaims);
const noClaims = writeJson("none.json", []);
const origin = () => git(bare, "rev-parse", "main");
const count = () => Number(git(bare, "rev-list", "--count", "main"));
const hist = () => showOrigin("bugs/B1.md");
const shaLines = () =>
  hist()
    .split("\n")
    .filter((l) => [c1, c2, c4].some((s) => l.includes(s.slice(0, 8))))
    .sort();
const seen = () => [c1, c2, c4].map((s) => hist().includes(s.slice(0, 8)));
const anchorSha = (n) => JSON.parse(readFileSync(an(n), "utf8")).lastSha;

const filed = run(
  BUGS,
  ["file", "Bug one", "--location", "apps/api/x.ts", "--severity", "low", "--batch", "F01"].concat([
    "--tier",
    "T1",
  ]),
  regEnv(A, an("a")),
);
check("fixture: B1 filed in clone mode", [filed.status, /filed B1/.test(filed.stdout)], [0, true]);
const sha0 = origin();
const fresh = () => {
  git(bare, "update-ref", "refs/heads/main", sha0);
  for (const n of ["a", "b"]) rmSync(an(n), { force: true });
};

async function main() {
  await section("refusals: a dirty main checkout, HEAD != M", async () => {
    appendFileSync(join(rf, "f.txt"), "dirty\n");
    const r1 = land(["--sha", tip, "--claims", okFile], regEnv(A, an("a")));
    git(rf, "checkout", "--", "f.txt");
    const r2 = land(["--sha", c4, "--claims", okFile], regEnv(A, an("a")));
    check(
      "a dirty main checkout is refused, nothing written",
      [r1.status, origin() === sha0, existsSync(an("a"))],
      [2, true, false],
    );
    check("HEAD != M is refused", [r2.status, origin() === sha0], [2, true]);
  });

  await section("a bad claims file is refused before the lock", async () => {
    const bad = {
      "not json": "{nope",
      "not an array": "{}",
      "unknown action": [{ id: "B1", action: "close" }],
      "prove without the REG token": [{ id: "B1", action: "prove", pr: 3901, proof: "none" }],
      "prove with a bad pr": [{ id: "B1", action: "prove", pr: -1, proof: "REG-B1 x" }],
      "note without text": [{ id: "B1", action: "note", text: " " }],
      "a bad id": [{ id: "x1", action: "note", text: "t" }],
      "one bad among good ones": [...okClaims, { id: "B1", action: "note" }],
    };
    for (const [name, v] of Object.entries(bad)) {
      // the clone dir does not exist: only a check made before the lock names the claims file
      const r = land(
        ["--sha", tip, "--claims", writeJson("bad.json", v)],
        regEnv(join(tmp, "no"), an("a")),
      );
      check(
        `${name}: exit 2 naming the claims, register and anchor untouched`,
        [r.status, /claims/.test(r.stderr), origin() === sha0, existsSync(an("a"))],
        [2, true, true, false],
      );
    }
  });

  await section("the fetch refreshes a stale origin/master", async () => {
    const ref = () => git(rf, "rev-parse", "refs/remotes/origin/master");
    const was = ref();
    const r = land(["--sha", tip, "--claims", noClaims], regEnv(A, an("a")));
    check(
      "land succeeds on a stale origin/master and refreshes it",
      [was === c4, r.status, ref() === tip],
      [true, 0, true],
    );
    fresh();
  });

  await section("L1/L2/L5 the anchor rule", async () => {
    writeJson("anchor-a.json", { lastSha: c0 });
    const anchored = sumOf(land(["--sha", tip, "--claims", noClaims], regEnv(A, an("a"))));
    const want = shaLines();
    check(
      "an anchored run records the mentions",
      [anchored?.scan, anchored?.before === c0.slice(0, 8), want.length, anchorSha("a")],
      ["anchored", true, 3, tip],
    );
    fresh();
    const r1 = sumOf(land(["--sha", tip, "--claims", noClaims], regEnv(A, an("a"))));
    check(
      "L1 no anchor: --rescan, and its events equal an anchored run's",
      [r1?.scan, r1?.before, r1?.events === anchored?.events, shaLines(), anchorSha("a")],
      ["rescan", "none", true, want, tip],
    );
    for (const bad of ["0123456789abcdef0123456789abcdef01234567", "not-a-sha"]) {
      fresh();
      writeJson("anchor-a.json", { lastSha: bad });
      const r2 = sumOf(land(["--sha", tip, "--claims", noClaims], regEnv(A, an("a"))));
      check(
        `L2 anchor "${bad.slice(0, 9)}" is not a commit: --rescan`,
        [r2?.scan, r2?.before, shaLines()],
        ["rescan", "invalid", want],
      );
    }
    fresh();
    writeJson("anchor-a.json", { lastSha: c2 });
    const r5 = sumOf(land(["--sha", tip, "--claims", noClaims], regEnv(A, an("a"))));
    check(
      "L5 a valid anchor: a plain sync (c1, c2 are behind it), not a rescan",
      [r5?.scan, seen()],
      ["anchored", [false, false, true]],
    );
    fresh();
  });

  await section("L3 M older than the rescan window", async () => {
    git(tmp, "init", "--bare", "--initial-branch=master", join(tmp, "big.git"));
    git(tmp, "clone", join(tmp, "big.git"), "big");
    const big = join(tmp, "big");
    const first = commit(big, "feat: old (B1)");
    git(big, "push", "origin", "HEAD:master");
    git(big, "checkout", "--detach", first);
    const stream = Array.from({ length: 405 }, (_, i) => {
      const msg = `chore: filler ${i}`;
      const from = i ? "" : `from ${first}\n`;
      return `commit refs/heads/master\ncommitter t <t@t> ${1000 + i} +0000\ndata ${msg.length}\n${msg}\n${from}\n`;
    }).join("");
    spawnSync("git", ["fast-import", "--quiet"], {
      cwd: big,
      input: stream,
      encoding: "utf8",
      env: scrubbedGitEnv(),
    });
    git(big, "push", "origin", "refs/heads/master:master");
    const at = (n) => git(big, "rev-list", "--skip", String(n), "--max-count=1", "master");
    const tryAt = (sha) => {
      git(big, "checkout", "--detach", sha);
      return land(
        ["--sha", sha, "--claims", noClaims],
        regEnv(A, an("a"), { BUGS_SYNC_REPO: big }),
      );
    };
    const edge = tryAt(at(400));
    check(
      "M 400 commits behind: exit 2, the exact message, no write, no anchor",
      [edge.status, edge.stderr.includes(GAP), origin() === sha0, existsSync(an("a"))],
      [2, true, true, false],
    );
    check("M 399 commits behind is inside the window", tryAt(at(399)).status, 0);
    rmSync(an("a"), { force: true });
    check("a very old M also gaps", [tryAt(first).status, origin() === sha0], [2, true]);
    fresh();
  });

  await section("L4 M must be in origin/master", async () => {
    const local = commit(rf, "feat: never pushed (B1)");
    const r = land(["--sha", local, "--claims", noClaims], regEnv(A, an("a")));
    git(rf, "reset", "--hard", tip);
    check(
      "an unpushed M: exit 2, no write",
      [r.status, /origin\/master/.test(r.stderr), origin() === sha0, existsSync(an("a"))],
      [2, true, true, false],
    );
  });

  await section("claims: prove and note land in one commit; L6 a second machine", async () => {
    const before = count();
    const r = land(["--sha", tip, "--claims", okFile], regEnv(A, an("a")));
    const s = sumOf(r);
    check(
      "one commit on origin, claims applied, events recorded",
      [r.status, count() - before, s?.claims, s?.events > 0],
      [0, 1, 2, true],
    );
    check(
      "the ledger row is proven and the note is in the record",
      [
        /"state":"proven"/.test(showOrigin("status/F01.jsonl")),
        showOrigin("status/F01.jsonl").includes('"pr":3901'),
        hist().includes("landed with the follow-up"),
      ],
      [true, true, true],
    );
    const landed = origin();
    const again = land(["--sha", tip, "--claims", okFile], regEnv(B, an("b")));
    const a2 = sumOf(again);
    check(
      "L6 a second machine (own clone, no anchor): no new commit, no events",
      [again.status, origin() === landed, a2?.scan, a2?.events],
      [0, true, "rescan", 0],
    );
    check(
      "no duplicate note or ledger row",
      [
        hist().split("landed with the follow-up").length - 1,
        showOrigin("status/F01.jsonl")
          .split("\n")
          .filter((l) => l.includes('"B1"')).length,
      ],
      [1, 1],
    );
    fresh();
  });

  await section("a rejected push redoes the whole landing", async () => {
    const flag = fwd(join(tmp, "rejected-once"));
    const hook = join(bare, "hooks", "pre-receive");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ ! -e "${flag}" ]; then : > "${flag}"; echo no >&2; exit 1; fi\n`,
    );
    chmodSync(hook, 0o755);
    writeJson("anchor-a.json", { lastSha: c0 }); // a valid anchor: the redo must not scan from the advanced one
    const before = count();
    const r = land(["--sha", tip, "--claims", okFile], regEnv(A, an("a")));
    rmSync(hook);
    check(
      "the first push was rejected, the second landed sync and claims once",
      [r.status, existsSync(flag), count() - before, shaLines().length, seen()],
      [0, true, 1, 3, [true, true, true]],
    );
    check(
      "no duplicate rows after the redo",
      [hist().split("landed with the follow-up").length - 1, anchorSha("a")],
      [1, tip],
    );
    fresh();
  });

  await section(
    "round 3: notes, the anchor across an aborted push, tracked mode, a failed claim",
    async () => {
      // MUST 1: a note is skipped only when a History note line holds that exact text.
      fresh();
      writeJson("anchor-a.json", { lastSha: c0 });
      const titleNote = writeJson("title-note.json", [
        { id: "B1", action: "note", text: "Bug one" },
      ]);
      const noteLine = (t) =>
        hist()
          .split("\n")
          .filter((l) => l.includes(`**note** · ${t} <!--`));
      const n1 = sumOf(land(["--sha", tip, "--claims", titleNote], regEnv(A, an("a"))));
      check(
        "a note whose text is the bug's title is recorded, and counted as applied",
        [noteLine("Bug one").length, n1?.claims, n1?.skipped],
        [1, 1, 0],
      );
      const n2 = sumOf(land(["--sha", tip, "--claims", titleNote], regEnv(B, an("b"))));
      check(
        "the same note again is skipped, once only, and counted as skipped",
        [noteLine("Bug one").length, n2?.claims, n2?.skipped],
        [1, 0, 1],
      );
      fresh();

      // MUST 2: the child sync works on a temp copy; the real anchor moves only after the push landed.
      writeJson("anchor-a.json", { lastSha: c0 });
      const seenAtPush = join(tmp, "anchor-at-push.json");
      const reject = join(bare, "hooks", "pre-receive");
      mkdirSync(dirname(reject), { recursive: true });
      writeFileSync(
        reject,
        `#!/bin/sh\ncp "${fwd(an("a"))}" "${fwd(seenAtPush)}" 2>/dev/null\necho no >&2\nexit 1\n`,
      );
      chmodSync(reject, 0o755);
      const aborted = land(["--sha", tip, "--claims", okFile], regEnv(A, an("a")));
      rmSync(reject);
      check(
        "every push rejected: exit 1, the real anchor never moved (not even during the push)",
        [
          aborted.status,
          origin() === sha0,
          anchorSha("a") === c0,
          existsSync(seenAtPush) && JSON.parse(readFileSync(seenAtPush, "utf8")).lastSha === c0,
        ],
        [1, true, true, true],
      );
      const redo = land(["--sha", tip, "--claims", okFile], regEnv(A, an("a")));
      check(
        "the next run re-scans the same events and lands them",
        [redo.status, shaLines().length, anchorSha("a")],
        [0, 3, tip],
      );
      fresh();

      // MUST 3: registry:land is clone-mode only.
      const trackedEnv = regEnv(A, an("a"));
      delete trackedEnv.RF_REGISTRY_MODE_TEST;
      const tracked = land(["--sha", tip, "--claims", okFile], trackedEnv);
      check(
        "tracked mode: exit 2 naming it, no commit, the anchor unwritten",
        [tracked.status, /tracked/.test(tracked.stderr), origin() === sha0, existsSync(an("a"))],
        [2, true, true, false],
      );

      fresh(); // the unfixed tracked run landed a commit; every check below starts from sha0
      // MUST 4: a claim that fails leaves the clone clean and origin unchanged.
      writeJson("anchor-a.json", { lastSha: c0 }); // a valid anchor, so the sync before the claim writes
      const failing = writeJson("fail.json", [
        { id: "B999", action: "prove", pr: 1, proof: "REG-B999 x" },
      ]);
      const failed = land(["--sha", tip, "--claims", failing], regEnv(A, an("a")));
      check(
        "a failed claim: non-zero, the clone clean, origin and the anchor unchanged",
        [failed.status !== 0, fx.clean(A), origin() === sha0, anchorSha("a") === c0],
        [true, true, true, true],
      );
      fresh();
    },
  );

  await section(
    "steps 2-3: campaign-check runs before the push; a failure pushes nothing",
    async () => {
      const log = join(tmp, "stub.log");
      const seenBy = () =>
        existsSync(log)
          ? readFileSync(log, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : [];
      const e = (extra) =>
        regEnv(A, an("a"), {
          STUB_LOG: log,
          GIT_AUTHOR_NAME: "leak",
          RF_VERIFY_MODE: "fast",
          ...extra,
        });
      const before = count();
      const ok = land(["--sha", tip, "--claims", okFile], e({}));
      const [saw] = seenBy();
      check(
        "a passing check lets the push land (one commit), run once with --landing",
        [ok.status, count() - before, seenBy().length, saw?.args],
        [0, 1, 1, ["--landing"]],
      );
      check(
        "it sees STATUS_DIR = the clone's status, CODE_ROOT = the main checkout, a scrubbed git env, no RF_VERIFY_MODE",
        [resolve(saw?.status ?? "x"), resolve(saw?.code ?? "x"), saw?.leak, saw?.mode],
        [resolve(join(A, rr.REGISTRY_PREFIX, "status")), resolve(rf), null, null],
      );
      check("it runs after the claims are written, before the push", saw?.proven, true);
      fresh();
      rmSync(log, { force: true });

      const was = origin();
      const bad = land(["--sha", tip, "--claims", okFile], e({ STUB_FAIL: "1" }));
      check(
        "a failing check: exit 1 (not 2), the check's tail and the notice, nothing pushed, no anchor",
        [
          bad.status,
          bad.stderr.includes("stub: F01 B1 refused"),
          bad.stderr.includes("registry:land: campaign-check failed; nothing pushed"),
          origin() === was,
          existsSync(an("a")),
        ],
        [1, true, true, true, false],
      );
      check(
        "the clone is left clean and at origin",
        [git(A, "status", "--porcelain"), git(A, "rev-parse", "HEAD") === was],
        ["", true],
      );
      const again = land(["--sha", tip, "--claims", okFile], e({}));
      check("the next landing from that clone works", [again.status, origin() !== was], [0, true]);
      fresh();
      rmSync(log, { force: true });

      const flag = fwd(join(tmp, "rejected-check-once"));
      const hook = join(bare, "hooks", "pre-receive");
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(
        hook,
        `#!/bin/sh\nif [ ! -e "${flag}" ]; then : > "${flag}"; echo no >&2; exit 1; fi\n`,
      );
      chmodSync(hook, 0o755);
      const redo = land(["--sha", tip, "--claims", okFile], e({}));
      rmSync(hook);
      check(
        "a rejected push redoes the landing, and the check runs again before the second push",
        [redo.status, existsSync(flag), seenBy().length, seenBy().every((s) => s.proven)],
        [0, true, 2, true],
      );
      fresh();
      const pick = (env) =>
        typeof rr.landCheckOverride === "function" ? rr.landCheckOverride(env) : "unavailable";
      check(
        "REGISTRY_LAND_CHECK_CMD is honoured only under BUGS_SELF_TEST=1",
        [
          pick({ REGISTRY_LAND_CHECK_CMD: "stub.mjs" }),
          pick({ REGISTRY_LAND_CHECK_CMD: "stub.mjs", BUGS_SELF_TEST: "0" }),
          pick({ BUGS_SELF_TEST: "1" }),
          pick({ REGISTRY_LAND_CHECK_CMD: "stub.mjs", BUGS_SELF_TEST: "1" }),
        ],
        [null, null, null, "stub.mjs"],
      );
    },
  );

  await section(
    "the land-check hook warns, is read through landCheckOverride, is bounded",
    async () => {
      const warned = land(["--sha", tip, "--claims", okFile], regEnv(A, an("a")));
      check(
        "a honoured REGISTRY_LAND_CHECK_CMD prints a WARNING",
        [warned.status, /WARNING: REGISTRY_LAND_CHECK_CMD/.test(warned.stderr)],
        [0, true],
      );
      fresh();
      const src = readFileSync(LAND, "utf8");
      check(
        "registry-land.mjs never reads REGISTRY_LAND_CHECK_CMD itself: only through landCheckOverride",
        [
          /env(\.|\[["'])REGISTRY_LAND_CHECK_CMD/.test(src.replace(/^\/\/.*$/gm, "")),
          src.includes("landCheckOverride()"),
        ],
        [false, true],
      );
      const was = origin();
      const t0 = Date.now();
      const slow = land(
        ["--sha", tip, "--claims", okFile],
        regEnv(A, an("a"), { STUB_HANG: "1", REGISTRY_LAND_CHECK_TIMEOUT_MS: "1500" }),
      );
      check(
        "a check that outlives its timeout: exit 2 saying so, nothing pushed, the clone clean",
        [
          slow.status,
          /timed out/.test(slow.stderr),
          origin() === was,
          git(A, "status", "--porcelain"),
        ],
        [2, true, true, ""],
      );
      check(
        "the timeout fired well before the check would have ended",
        Date.now() - t0 < 7000,
        true,
      );
      fresh();
    },
  );

  await section("a redo: notes match trimmed, a prove already applied is skipped", async () => {
    const noteOnly = writeJson("note.json", [
      { id: "B1", action: "note", text: "ends with a mark -->" },
    ]);
    const proveOnly = writeJson("prove.json", [okClaims[0]]);
    land(["--sha", tip, "--claims", noteOnly], regEnv(A, an("a")));
    const redo = sumOf(land(["--sha", tip, "--claims", noteOnly], regEnv(A, an("a"))));
    check(
      "a note whose cleaned text ends in whitespace is held, not added twice",
      [hist().split("ends with a mark").length - 1, redo?.claims, redo?.skipped],
      [1, 0, 1],
    );
    fresh();
    land(["--sha", tip, "--claims", proveOnly], regEnv(A, an("a")));
    const before = origin();
    const again = sumOf(land(["--sha", tip, "--claims", proveOnly], regEnv(A, an("a"))));
    check(
      "a prove already on origin is reported as skipped, nothing new is written",
      [again?.claims, again?.skipped, origin() === before],
      [0, 1, true],
    );
    fresh();
  });

  await section(
    "a failed land removes its temp anchor; a missing anchor is a warning",
    async () => {
      const temps = () => readdirSync(tmp).filter((n) => n.startsWith("anchor-a.json.land-"));
      writeJson("anchor-a.json", { lastSha: c0 }); // valid: the child sync works on a copy
      const unknown = writeJson("unknown.json", [
        { id: "B999", action: "note", text: "no such bug" },
      ]);
      const failed = land(["--sha", tip, "--claims", unknown], regEnv(A, an("a")));
      check(
        "a land that fails leaves no .land-<pid> file, the register and the anchor untouched",
        [failed.status !== 0, temps(), origin() === sha0, anchorSha("a")],
        [true, [], true, c0],
      );
      // the push window removes the anchor and its temp copy: nothing for the land to move into place
      const hook = join(bare, "hooks", "pre-receive");
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, `#!/bin/sh\nrm -f "${fwd(an("a"))}" "${fwd(an("a"))}".land-*\n`);
      chmodSync(hook, 0o755);
      const before = count();
      const r = land(["--sha", tip, "--claims", okFile], regEnv(A, an("a")));
      rmSync(hook);
      check(
        "no anchor after a landed push: a clear warning, exit 0, no stack trace, the landing recorded",
        [
          r.status,
          /anchor/i.test(r.stderr + r.stdout),
          /\n\s+at /.test(r.stderr),
          count() - before,
        ],
        [0, true, false, 1],
      );
      fresh();
    },
  );

  await section("sync on origin/master; tracked mode unchanged", async () => {
    const sy = join(tmp, "sy");
    git(tmp, "init", "--bare", "--initial-branch=master", join(tmp, "sy.git"));
    git(tmp, "clone", join(tmp, "sy.git"), "sy");
    commit(sy, "feat: pushed");
    git(sy, "push", "origin", "HEAD:master");
    commit(sy, "feat: local only");
    const elsewhere = join(tmp, "elsewhere-repo");
    git(tmp, "init", "--initial-branch=master", elsewhere);
    commit(elsewhere, "feat: elsewhere");
    const reg = join(tmp, "fixture-reg");
    mkdirSync(join(reg, "status"), { recursive: true });
    writeFileSync(join(reg, "bugs.jsonl"), "");
    const probe = join(tmp, "probe.mjs");
    const seenEnv = join(tmp, "seen-env.json");
    writeFileSync(
      probe,
      `import { spawnSync as sh } from "node:child_process";
import { writeFileSync } from "node:fs";
const { GIT_TERMINAL_PROMPT: p, GCM_INTERACTIVE: g } = process.env;
writeFileSync(${JSON.stringify(seenEnv)}, JSON.stringify([p, g]));
// the shim is generated source the fixture scanner cannot read, so it scrubs GIT_* itself
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
process.exit(sh("git", ["upload-pack", ...process.argv.slice(2)], { stdio: "inherit", env }).status ?? 1);
`,
    );
    const sync = (extra, cwd) => {
      rmSync(an("s"), { force: true });
      const e = { ...regEnv(A, an("s"), { BUGS_SYNC_REPO: sy, BUGS_ROOT: reg }), ...extra };
      for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
      run(BUGS, ["sync", "--quiet"], e, cwd);
      return anchorSha("s");
    };
    const mark = { RF_REGISTRY_MODE_TEST: undefined };
    check(
      "clone mode anchors on origin/master",
      sync({}),
      git(sy, "rev-parse", "refs/remotes/origin/master"),
    );
    git(tmp, "clone", join(tmp, "sy.git"), "sy2");
    commit(join(tmp, "sy2"), "feat: landed elsewhere");
    git(join(tmp, "sy2"), "push", "origin", "HEAD:master");
    git(sy, "config", "remote.origin.uploadpack", `node ${fwd(probe)}`);
    check(
      "clone mode fetches first: a stale local origin/master is refreshed",
      sync({}),
      git(join(tmp, "sy2"), "rev-parse", "HEAD"),
    );
    check(
      "the fetch never prompts: GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never",
      JSON.parse(readFileSync(seenEnv, "utf8")),
      ["0", "never"],
    );
    git(sy, "config", "--unset", "remote.origin.uploadpack");
    check("tracked mode still anchors on HEAD", sync(mark), git(sy, "rev-parse", "HEAD"));
    check(
      "BUGS_SYNC_REPO is ignored without BUGS_SELF_TEST: git runs in the cwd",
      sync({ ...mark, BUGS_SELF_TEST: undefined }, elsewhere),
      git(elsewhere, "rev-parse", "HEAD"),
    );
    const src = readFileSync(BUGS, "utf8");
    check(
      "the sync git calls carry REGISTRY_GIT_TIMEOUT_MS in clone mode only",
      src.includes('registryMode() === "clone" ? { timeout: REGISTRY_GIT_TIMEOUT_MS }'),
      true,
    );
  });
}

await main();
fx.finish("registry-land");
