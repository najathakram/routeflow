#!/usr/bin/env node
/**
 * Self-test for lead-sweep.mjs (delta-only fleet sweeper) — offline, no gh/git, < 2 s.
 * Tests inject `gather`; production code has no env or fixture hook. Only T30 spawns the CLI.
 * Case numbers follow local-assets/handoff/2026-09-29-lead-sweep-spec.md.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { run, ciState } from "./lead-sweep.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-09-29T03:10:00Z");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        ${detail}`}`);
};
const j = (v) => JSON.stringify(v);

// ---- fixtures -------------------------------------------------------------------------------
const okCheck = (name = "verify") => ({
  name,
  status: "COMPLETED",
  conclusion: "SUCCESS",
  startedAt: "2026-09-29T03:00:00Z",
  completedAt: "2026-09-29T03:05:00Z",
});
const failCheck = (name, secs) => ({
  name,
  status: "COMPLETED",
  conclusion: "FAILURE",
  startedAt: "2026-09-29T03:00:00Z",
  completedAt: new Date(Date.parse("2026-09-29T03:00:00Z") + secs * 1000).toISOString(),
});
const pendCheck = (name = "verify") => ({ name, status: "IN_PROGRESS", conclusion: "" });
const pr = (n, over = {}) => ({
  number: n,
  title: `t${n}`,
  sha: `p${n}`,
  isDraft: false,
  base: "master",
  rollup: [okCheck()],
  ...over,
});
const snap0 = (over = {}) => ({
  master: { ok: true, data: { sha: "aaa" } },
  vis: { ok: true, data: { state: "PRIVATE", lockDeadline: null } },
  prs: { ok: true, data: [pr(1)] },
  board: { ok: true, data: { comments: [{ id: 100, author: "lead", body: "old", url: "u100" }] } },
  deploy: { ok: true, data: { envs: { production: { state: "SUCCESS", sha: "aaa" } } } },
  watchdog: { ok: true, data: { failed: null } },
  prView: async () => ({ ok: false, error: "no view" }),
  ...over,
});
const tmp = () => mkdtempSync(join(tmpdir(), "lead-sweep-"));
const go = (dir, snap, extra = {}) =>
  run({ argv: [], gather: async () => snap, stateDir: dir, now: NOW, redactTerms: [], ...extra });
const baseline = async (dir, snap = snap0(), extra = {}) => go(dir, snap, extra);
const stateOf = (dir) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
const rawState = (dir) => readFileSync(join(dir, "state.json"), "utf8");
const only = (r, tag) => r.lines.filter((l) => l.startsWith(tag));
const prsOf = (...list) => ({ prs: { ok: true, data: list } });

const t = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, `threw ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
};

await t("T1", async () => {
  const d = tmp();
  await baseline(d);
  const before = rawState(d);
  const r = await go(d, snap0());
  check("T1 no change => silent, exit 0, state identical", r.code === 0 && r.lines.length === 0 && rawState(d) === before, j(r));
});
await t("T2", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0({ master: { ok: true, data: { sha: "bbb" } } }));
  check(
    "T2 master moved => one MASTER line, exit 10, slice advances",
    r.code === 10 && r.lines.length === 1 && /^MASTER aaa->bbb /.test(r.lines[0]) && stateOf(d).sections.master.sha === "bbb",
    j(r),
  );
});
await t("T3", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0({ vis: { ok: true, data: { state: "PUBLIC", lockDeadline: null } } }));
  check("T3 PUBLIC no lock", r.code === 10 && /^VIS PUBLIC watchdog=none-local/.test(r.lines[0] || ""), j(r));
});
await t("T4", async () => {
  const d = tmp();
  const pub = () => snap0({ vis: { ok: true, data: { state: "PUBLIC", lockDeadline: "D1" } } });
  await baseline(d, pub());
  const r = await go(d, pub());
  check("T4 PUBLIC->PUBLIC reprints VIS with lock(D)", r.code === 10 && /^VIS PUBLIC watchdog=lock\(D1\)/.test(r.lines[0] || ""), j(r));
});
await t("T5", async () => {
  const d = tmp();
  await baseline(d, snap0({ vis: { ok: true, data: { state: "PUBLIC", lockDeadline: null } } }));
  const r1 = await go(d, snap0());
  const r2 = await go(d, snap0());
  check("T5 PRIVATE again once, then silent", /^VIS PRIVATE again/.test(r1.lines[0] || "") && r2.code === 0 && r2.lines.length === 0, j([r1, r2]));
});
await t("T6", async () => {
  const d = tmp();
  await baseline(d);
  const f = () => snap0({ watchdog: { ok: true, data: { failed: "boom happened" } } });
  const r1 = await go(d, f());
  const r2 = await go(d, f());
  check("T6 WATCHDOG once", /^WATCHDOG boom happened/.test(r1.lines[0] || "") && r2.code === 0 && r2.lines.length === 0, j([r1, r2]));
});
await t("T7", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0(prsOf(pr(1), pr(2))));
  check("T7 PR+", r.lines.length === 1 && /^PR\+ #2 p2 draft=no base=master t2/.test(r.lines[0]), j(r));
});
for (const [n, moved] of [[8, true], [9, false]]) {
  await t(`T${n}`, async () => {
    const d = tmp();
    await baseline(d);
    const r = await go(
      d,
      snap0({
        ...prsOf(),
        master: { ok: true, data: { sha: moved ? "bbb" : "aaa" } },
        prView: async () => ({ ok: true, data: { state: "MERGED", mergeSha: "m1" } }),
      }),
    );
    const want = `master-moved=${moved ? "yes" : "NO"}`;
    const line = only(r, "MERGED")[0] || "";
    check(`T${n} MERGED ${want}`, line.includes("MERGED #1 m1") && line.includes(want), j(r));
  });
}
await t("T10", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0({ ...prsOf(), prView: async () => ({ ok: true, data: { state: "CLOSED", mergeSha: null } }) }));
  check("T10 CLOSED", /^CLOSED #1/.test(r.lines[0] || ""), j(r));
});
await t("T11", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0({ ...prsOf(), prView: async () => ({ ok: false, error: "view down" }) }));
  check(
    "T11 view fails => ERR pr#1, exit 10, #1 kept",
    r.code === 10 && /^ERR pr#1: view down/.test(r.lines[0] || "") && !!stateOf(d).sections.prs["1"],
    j(r),
  );
});
await t("T12", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0(prsOf(pr(1, { sha: "p2", rollup: [pendCheck()] }))));
  check("T12 HEAD re-pin, no CI line", r.lines.length === 1 && /^HEAD #1 p1->p2 re-pin verdicts/.test(r.lines[0]) && only(r, "CI").length === 0, j(r));
});
await t("T13", async () => {
  const d = tmp();
  await baseline(d);
  const r1 = await go(d, snap0(prsOf(pr(1, { isDraft: true }))));
  const r2 = await go(d, snap0(prsOf(pr(1, { isDraft: true, base: "feat/x" }))));
  check(
    "T13 DRAFT + BASE !gate",
    /^DRAFT #1 no->yes/.test(r1.lines[0] || "") && /^BASE #1 master->feat\/x .*!gate/.test(r2.lines[0] || ""),
    j([r1, r2]),
  );
});
await t("T14", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0(prsOf(pr(1, { rollup: [failCheck("lint", 300), okCheck("build")] }))));
  check("T14 RED (lint)", /^CI #1 p1 RED \(lint\)/.test(r.lines[0] || ""), j(r));
});
await t("T15", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0(prsOf(pr(1, { rollup: [failCheck("a", 4), failCheck("b", 4)] }))));
  check(
    "T15 4 s failures => BLOCKED(billing?), never RED",
    /BLOCKED\(billing\?\)/.test(r.lines[0] || "") && !r.lines.some((l) => /RED/.test(l)),
    j(r),
  );
  const c = ciState([failCheck("a", 4)]);
  check("T15b ciState unit", c.state === "BLOCKED", j(c));
});
await t("T16", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(d, snap0(prsOf(pr(1, { rollup: [failCheck("quick4s", 4), failCheck("slow200s", 200)] }))));
  check("T16 RED names only the slow one", /RED \(slow200s\)/.test(r.lines[0] || "") && !/quick4s/.test(r.lines[0]), j(r));
});
await t("T17", async () => {
  const d = tmp();
  await baseline(d);
  const r1 = await go(d, snap0(prsOf(pr(1, { rollup: [pendCheck()] }))));
  const r2 = await go(d, snap0());
  check("T17 GREEN->PENDING silent; PENDING->GREEN prints", r1.lines.length === 0 && /^CI #1 p1 GREEN/.test(r2.lines[0] || ""), j([r1, r2]));
});
await t("T18", async () => {
  const d = tmp();
  await baseline(d);
  const cm = (id, body) => ({ id, author: "opus", body, url: `https://x/${id}` });
  const r = await go(d, snap0({ board: { ok: true, data: { comments: [cm(102, "second"), cm(100, "old"), cm(101, "first")] } } }));
  check(
    "T18 two BOARD lines in id order, lastSeen 102",
    r.lines.length === 2 && /first/.test(r.lines[0]) && /second/.test(r.lines[1]) && /opus/.test(r.lines[0]) &&
      /https:\/\/x\/101/.test(r.lines[0]) && stateOf(d).sections.board.lastSeen === 102,
    j(r),
  );
});
await t("T19", async () => {
  const d = tmp();
  await baseline(d);
  const body = "\r\n## PASS #1 @ abc\r\nmore";
  const r = await go(d, snap0({ board: { ok: true, data: { comments: [{ id: 101, author: "a", body, url: "u" }] } } }));
  check("T19 first line only, no CR", r.lines.length === 1 && /PASS #1 @ abc/.test(r.lines[0]) && !/more/.test(r.lines[0]) && !/\r/.test(r.lines[0]), j(r));
});
await t("T20", async () => {
  const d = tmp();
  await baseline(d);
  const r = await go(
    d,
    snap0({ board: { ok: true, data: { comments: [{ id: 101, author: "a", body: "Acme-Live is late", url: "u" }] } } }),
    { redactTerms: ["acme-live"] },
  );
  check("T20 redacted", /\[redacted\]/.test(r.lines[0] || "") && !/acme-live/i.test(r.lines.join("\n")), j(r));
});
await t("T21", async () => {
  const d = tmp();
  await baseline(d, snap0(), { boardIssue: 2554 });
  const many = [{ id: 4000, author: "a", body: "x", url: "u" }, { id: 5000, author: "a", body: "y", url: "u" }];
  const r = await go(d, snap0({ board: { ok: true, data: { comments: many } } }), { boardIssue: 2600 });
  check(
    "T21 board rolled, no replay",
    r.lines.length === 1 && /^BOARD rolled #2554->#2600/.test(r.lines[0]) && stateOf(d).sections.board.lastSeen === 5000 && stateOf(d).board === 2600,
    j(r),
  );
});
await t("T22", async () => {
  const d = tmp();
  await baseline(d);
  const dep = (state, sha) => snap0({ deploy: { ok: true, data: { envs: { production: { state, sha } } } } });
  const r1 = await go(d, dep("IN_PROGRESS", "bbb"));
  const r2 = await go(d, dep("FAILURE", "bbb"));
  const r3 = await go(d, snap0({ deploy: { ok: true, data: { envs: {} } } }));
  check(
    "T22 DEPLOY on terminal change; in-progress and empty silent",
    r1.lines.length === 0 && /^DEPLOY production FAILURE bbb/.test(r2.lines[0] || "") && r3.lines.length === 0,
    j([r1, r2, r3]),
  );
});
await t("T23", async () => {
  const d = tmp();
  const r1 = await baseline(d);
  const r2 = await go(d, snap0());
  check(
    "T23 BASELINE then exit 0",
    r1.code === 10 && r1.lines.length === 1 && /^BASELINE master=aaa prs=1 board=#2554>100 vis=PRIVATE/.test(r1.lines[0]) &&
      existsSync(join(d, "state.json")) && r2.code === 0,
    j([r1, r2]),
  );
});
await t("T24", async () => {
  const d = tmp();
  writeFileSync(join(d, "state.json"), '{"v":1,');
  const r = await go(d, snap0());
  check(
    "T24 corrupt => re-baselined, file kept",
    r.code === 10 && r.lines.some((l) => /^STATE corrupt; re-baselined/.test(l)) && readdirSync(d).some((f) => f.startsWith("state.json.corrupt-")),
    j(r),
  );
});
await t("T25", async () => {
  const d = tmp();
  await baseline(d);
  const before = stateOf(d).sections.board;
  const r = await go(d, snap0({ master: { ok: true, data: { sha: "bbb" } }, board: { ok: false, error: "boom" } }));
  check(
    "T25 board fails, master advances",
    r.code === 10 && r.lines.some((l) => /^MASTER aaa->bbb/.test(l)) && r.lines.some((l) => /^ERR board: boom/.test(l)) &&
      j(stateOf(d).sections.board) === j(before) && stateOf(d).sections.master.sha === "bbb",
    j(r),
  );
});
await t("T26", async () => {
  const d = tmp();
  await baseline(d);
  const bad = () => snap0({ board: { ok: false, error: "boom" } });
  const r1 = await go(d, bad());
  const mid = [];
  for (let n = 2; n <= 6; n++) mid.push(await go(d, bad()));
  const r7 = await go(d, bad());
  const rec = await go(d, snap0());
  check(
    "T26 ERR n=1, silent exit 11 for n=2..6, reprint at n=7, OK on recovery",
    /^ERR board/.test(r1.lines[0] || "") && mid.every((r) => r.code === 11 && r.lines.length === 0) &&
      /^ERR board/.test(r7.lines[0] || "") && rec.code === 10 && /^OK board recovered/.test(rec.lines[0] || ""),
    j({ r1, mid: mid.map((r) => r.code), r7, rec }),
  );
});
await t("T27", async () => {
  const d = tmp();
  await baseline(d);
  const before = rawState(d);
  const r = await run({ argv: ["--dry-run"], gather: async () => snap0({ master: { ok: true, data: { sha: "bbb" } } }), stateDir: d, now: NOW, redactTerms: [] });
  check("T27 --dry-run", r.code === 10 && /^MASTER/.test(r.lines[0] || "") && rawState(d) === before && !existsSync(join(d, "lock")), j(r));
});
await t("T28", async () => {
  const d = tmp();
  await baseline(d);
  const before = rawState(d);
  const lock = (pid, ageMs) => writeFileSync(join(d, "lock"), j({ pid, startedAt: new Date(NOW.getTime() - ageMs).toISOString() }));
  lock(process.pid, 1000);
  const r = await go(d, snap0({ master: { ok: true, data: { sha: "bbb" } } }));
  const untouched = rawState(d) === before;
  lock(99999999, 1000);
  const r2 = await go(d, snap0());
  lock(process.pid, 11 * 60 * 1000);
  const r3 = await go(d, snap0());
  check(
    "T28 live fresh lock => exit 3 silent; dead pid or stale age => taken over",
    r.code === 3 && r.lines.length === 0 && untouched && r2.code !== 3 && r3.code !== 3 && !existsSync(join(d, "lock")),
    j([r.code, r2.code, r3.code]),
  );
});
await t("T29", async () => {
  const d = tmp();
  await baseline(d);
  const longTitle = "Big … change " + "x".repeat(400);
  const r = await go(d, snap0(prsOf(pr(1), pr(2, { title: longTitle }))));
  check(
    "T29a every line <=200 and printable ASCII",
    r.lines.length === 1 && r.lines[0].length <= 200 && /^[\x20-\x7E]+$/.test(r.lines[0]) && /\.\.\./.test(r.lines[0]),
    j(r.lines),
  );
  const d2 = tmp();
  await baseline(d2);
  const list = [pr(1)];
  for (let i = 0; i < 40; i++) list.push(pr(10 + i));
  const r2 = await go(d2, snap0(prsOf(...list)));
  check(
    "T29b 40 deltas => 25 lines + '... +15 more', state advances",
    r2.lines.length === 26 && /^\.\.\. \+15 more/.test(r2.lines[25]) && Object.keys(stateOf(d2).sections.prs).length === 41,
    j({ n: r2.lines.length, last: r2.lines[25] }),
  );
});
await t("T30", async () => {
  const d = join(tmp(), "nostate");
  const cli = join(HERE, "lead-sweep.mjs");
  const r = spawnSync(process.execPath, [cli, "--bogus", "--state-dir", d], { encoding: "utf8" });
  check("T30a --bogus => exit 2, usage, no state dir", r.status === 2 && /usage/i.test(r.stdout + r.stderr) && !existsSync(d), `${r.status} ${r.stderr}`);
  const r2 = spawnSync(process.execPath, ["-e", `import(${j(pathToFileURL(cli).href)}).then(()=>process.exit(0))`], { encoding: "utf8", timeout: 20000 });
  check("T30b import() does not run main", r2.status === 0 && r2.stdout === "" && r2.stderr === "", `${r2.status} ${r2.stdout}${r2.stderr}`);
});
await t("T31", async () => {
  const d = join(tmp(), "a b", "c d");
  mkdirSync(d, { recursive: true });
  await baseline(d);
  const raw = rawState(d);
  check("T31 space path works, LF only", existsSync(join(d, "state.json")) && !raw.includes("\r") && raw.endsWith("\n"), raw.slice(0, 60));
});
await t("T32", async () => {
  const src = readFileSync(join(HERE, "fleet-status.mjs"), "utf8");
  const imp = src.match(/import\s*\{[^}]*\}\s*from\s*"\.\/lib\/fleet-gather\.mjs"/)?.[0] || "";
  const names = ["trunc", "countChecks", "parseConcatArrays"];
  const named = names.every((n) => new RegExp(`\\b${n}\\b`).test(imp));
  const defines = names.some((n) => new RegExp(`(function\\s+${n}\\b|const\\s+${n}\\s*=)`).test(src));
  check("T32a fleet-status imports helpers, defines none", named && !defines, `named=${named} defines=${defines}`);
  let lib = null;
  try {
    lib = await import(pathToFileURL(join(HERE, "lib", "fleet-gather.mjs")).href);
  } catch (e) {
    check("T32b lib loads", false, String(e.message).split("\n")[0]);
    return;
  }
  const c = lib.countChecks([
    { conclusion: "SUCCESS" }, { conclusion: "NEUTRAL" }, { conclusion: "SKIPPED" },
    { conclusion: "FAILURE" }, { conclusion: "STARTUP_FAILURE" }, { state: "ERROR" },
    { conclusion: "" }, { state: "PENDING" },
  ]);
  check("T32b countChecks parity (STARTUP_FAILURE = fail)", j(c) === j({ pass: 3, fail: 3, pending: 2 }), j(c));
  check(
    "T32c trunc/parseConcatArrays/parseLsRemote",
    lib.trunc("a\nb", 10) === "a b" && lib.trunc("abcdef", 3) === "abc…" && j(lib.parseConcatArrays("[1][2]")) === "[1,2]" &&
      lib.parseLsRemote("abc\trefs/heads/master\n") === "abc",
    "",
  );
});
await t("T33", async () => {
  const d = tmp();
  await baseline(d);
  const rr = await run({ argv: ["--reset"], gather: async () => snap0(), stateDir: d, now: NOW, redactTerms: [] });
  const gone = !existsSync(join(d, "state.json"));
  const r = await go(d, snap0());
  check("T33 --reset then BASELINE", rr.code === 0 && gone && /^BASELINE/.test(r.lines[0] || ""), j([rr, r]));
});

console.log(failures === 0 ? "\nlead-sweep self-test: all green" : `\nlead-sweep self-test: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
