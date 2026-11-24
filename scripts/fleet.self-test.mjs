// Plain-node self-test for scripts/fleet.mjs (no network, exec and clock injected).
// Run: node scripts/fleet.self-test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-st-"));
const bodyFile = path.join(tmp, "body.md");
fs.writeFileSync(bodyFile, "status line for the board");
const emptyFile = path.join(tmp, "empty.md");
fs.writeFileSync(emptyFile, "");
const SECRET = "zzsecretzz";

const okPatterns = () => ({ ok: true, regexes: [new RegExp(SECRET, "i")] });
const noPatterns = () => ({ ok: false, message: "leak-check: no file. HOWTO-LINE" });
const ghExec = ({ api, comment }) => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "repo")
      return { status: 0, stdout: '{"nameWithOwner":"acme/app"}', stderr: "" };
    if (args[0] === "api") return api;
    if (args[0] === "issue")
      return comment ?? { status: 0, stdout: "https://x/y#c1\n", stderr: "" };
    throw new Error("unexpected " + args.join(" "));
  };
  exec.calls = calls;
  return exec;
};
const countOk = (n) => ({ status: 0, stdout: JSON.stringify({ comments: n }), stderr: "" });
const commented = (exec) => exec.calls.filter((c) => c[1] === "issue").length;
const postWith = async (over, exec) => {
  const { post } = await import("./lib/fleet/board.mjs");
  return post({
    issue: "4456",
    bodyFile,
    exec,
    cwd: tmp,
    loadPatterns: okPatterns,
    matchesBuf: (r, b) => r.some((re) => re.test(b.toString("utf8"))),
    ...over,
  });
};
const realRepo = () => {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  spawnSync("git", ["init", "-q"], { cwd: repo, env: scrubbedGitEnv() });
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".git", "info", "leak-patterns"),
    `${SECRET}
`,
  );
  return { repo, cwd: repo };
};
const realPost = async (over, exec) => {
  const { post } = await import("./lib/fleet/board.mjs");
  return post({ issue: "4456", exec, ...over });
};
const sub = async (s) => (await import("./lib/fleet/subject.mjs")).run([s]);

const cases = [
  [
    "T1 stamp format and --seconds",
    async () => {
      const { stamp } = await import("./lib/fleet/stamp.mjs");
      const now = new Date("2026-11-23T21:42:59.900Z");
      assert.equal(stamp({ now }), "2026-11-23T21:42Z");
      assert.equal(stamp({ now, seconds: true }), "2026-11-23T21:42:59Z");
    },
  ],
  [
    "T2 stamp ignores TZ",
    async () => {
      const r = spawnSync(
        process.execPath,
        [
          "-e",
          'import("./scripts/lib/fleet/stamp.mjs").then(m=>console.log(m.stamp({now:new Date("2026-11-23T21:42:59.900Z")})))',
        ],
        { env: { ...process.env, TZ: "America/Chicago" }, encoding: "utf8" },
      );
      assert.equal(r.stdout.trim(), "2026-11-23T21:42Z");
    },
  ],
  [
    "T3 subject ok",
    async () => {
      const r = await sub("feat(scripts): add the fleet cli for stamps, subjects and board posts");
      assert.deepEqual([r.code, r.lines], [0, ["ok (69 chars)"]]);
    },
  ],
  [
    "T4 subject bad",
    async () => {
      const r = await sub("Fix the thing");
      assert.equal(r.code, 1);
      assert.deepEqual(r.lines.map((l) => l.split(":")[0]).sort(), ["subject-empty", "type-empty"]);
      const c = await sub("feat: Fix The Thing");
      assert.equal(c.code, 1);
      assert.ok(c.lines.some((l) => l.startsWith("subject-case")));
    },
  ],
  [
    "T5 subject too long",
    async () => {
      assert.equal((await sub("feat: " + "a".repeat(72))).code, 0);
      const r = await sub("feat: " + "a".repeat(73));
      assert.equal(r.code, 1);
      assert.ok(r.lines.some((l) => l.startsWith("subject-max-length")));
    },
  ],
  [
    "T6 post at 2299",
    async () => {
      const exec = ghExec({ api: countOk(2299) });
      const r = await postWith({}, exec);
      assert.equal(r.code, 0);
      assert.equal(commented(exec), 1);
    },
  ],
  [
    "T7 post at 2300 refuses",
    async () => {
      const exec = ghExec({ api: countOk(2300) });
      const r = await postWith({}, exec);
      assert.equal(r.code, 5);
      assert.equal(commented(exec), 0);
    },
  ],
  [
    "T8 unreadable count refuses",
    async () => {
      for (const api of [
        { status: 1, stdout: "", stderr: "boom" },
        { status: 0, stdout: '{"comments":null}', stderr: "" },
        { status: 0, stdout: "not json", stderr: "" },
      ]) {
        const exec = ghExec({ api });
        const r = await postWith({}, exec);
        assert.equal(r.code, 3);
        assert.equal(commented(exec), 0);
      }
    },
  ],
  [
    "T9 leak match refuses, never echoed",
    async () => {
      fs.writeFileSync(path.join(tmp, "leak.md"), `hello ${SECRET} there`);
      const exec = ghExec({ api: countOk(1) });
      const r = await postWith({ bodyFile: path.join(tmp, "leak.md") }, exec);
      assert.equal(r.code, 4);
      assert.equal(commented(exec), 0);
      assert.ok(!r.lines.join("\n").includes(SECRET));
    },
  ],
  [
    "T10 no patterns refuses",
    async () => {
      const exec = ghExec({ api: countOk(1) });
      const r = await postWith({ loadPatterns: noPatterns }, exec);
      assert.equal(r.code, 4);
      assert.ok(r.lines.join("\n").includes("HOWTO-LINE"));
      assert.equal(commented(exec), 0);
    },
  ],
  [
    "T11 gh comment failure passes its code",
    async () => {
      const exec = ghExec({ api: countOk(1), comment: { status: 1, stdout: "", stderr: "nope" } });
      const r = await postWith({}, exec);
      assert.equal(r.code, 1);
    },
  ],
  [
    "T11b empty body exits 2",
    async () => {
      const exec = ghExec({ api: countOk(1) });
      const r = await postWith({ bodyFile: emptyFile }, exec);
      assert.equal(r.code, 2);
    },
  ],
  [
    "T15 real wiring (no injected patterns or matcher): utf-8 match refuses",
    async () => {
      const { repo, cwd } = realRepo();
      const exec = ghExec({ api: countOk(1) });
      const f = path.join(repo, "b.md");
      fs.writeFileSync(f, `x ${SECRET} y`);
      const r = await realPost({ bodyFile: f, cwd }, exec);
      assert.equal(r.code, 4);
      assert.equal(commented(exec), 0);
      assert.ok(!r.lines.join(" ").includes(SECRET));
      fs.writeFileSync(f, "clean text");
      assert.equal((await realPost({ bodyFile: f, cwd }, ghExec({ api: countOk(1) }))).code, 0);
    },
  ],
  [
    "T16 real wiring: UTF-16 body with a match refuses (H1)",
    async () => {
      const { repo, cwd } = realRepo();
      const exec = ghExec({ api: countOk(1) });
      const f = path.join(repo, "u16.md");
      const bytes = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`x ${SECRET}`, "utf16le"),
      ]);
      fs.writeFileSync(f, bytes);
      const r = await realPost({ bodyFile: f, cwd }, exec);
      assert.equal(r.code, 4);
      assert.equal(commented(exec), 0);
      assert.ok(!r.lines.join(" ").includes(SECRET));
    },
  ],
  [
    "T17 real wiring: UTF-16 body with no match still refuses (fail closed)",
    async () => {
      const { repo, cwd } = realRepo();
      const exec = ghExec({ api: countOk(1) });
      const f = path.join(repo, "u16b.md");
      fs.writeFileSync(f, Buffer.from("clean text", "utf16le"));
      const r = await realPost({ bodyFile: f, cwd }, exec);
      assert.equal(r.code, 4);
      assert.equal(commented(exec), 0);
    },
  ],
  [
    "T12 preflight statuses",
    async () => {
      const { run } = await import("./lib/fleet/preflight.mjs");
      const git = () => "feat/x abc1234";
      const r1 = run([], { check: () => ({ status: 1, message: "m" }), git });
      const r2 = run([], { check: () => ({ status: 2, message: "unreadable-msg" }), git });
      const r0 = run([], { check: () => ({ status: 0, message: "ok" }), git });
      assert.equal(r1.code, 1);
      assert.ok(r1.lines.join("\n").includes("node scripts/ensure-git-hooks.mjs"));
      assert.equal(r2.code, 2);
      assert.ok(r2.lines.join("\n").includes("unreadable-msg"));
      assert.equal(r0.code, 0);
      assert.ok(r0.lines.join("\n").includes("feat/x abc1234"));
    },
  ],
  [
    "T13 unknown subcommand",
    async () => {
      const { main } = await import("./fleet.mjs");
      const r = await main(["nope"]);
      assert.equal(r.code, 64);
      assert.ok(r.lines.join("\n").includes("stamp"));
    },
  ],
  [
    "T14 import spawns nothing",
    async () => {
      const m = await import("./fleet.mjs");
      assert.equal(typeof m.main, "function");
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log("ok   ", name);
  } catch (e) {
    failed++;
    console.log("FAIL ", name, "-", String(e.message).split("\n")[0]);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
