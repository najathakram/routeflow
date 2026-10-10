#!/usr/bin/env node
// Coverage for scripts/roadmap/render.mjs (F-22 WP1, build-plan.md
// 2026-09-24-f22-tracking-engine). Same standalone-script convention as
// plane-triage.self-test.mjs — no node:test: `node scripts/roadmap/render.self-test.mjs`,
// PASS/FAIL lines, `process.exit(failures ? 1 : 0)`.
//
// T1-T10, T36 (test-plan.md). Pinned clock: ROADMAP_SELF_TEST=1 + ROADMAP_NOW=2026-01-12T10:00:00Z
// on every spawn; `now` argument in-process. Every register dir is a per-run mkdtemp, tracked in
// FIXTURE_DIRS and swept in `finally`.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const t0 = performance.now();
const SCRIPT_PATH = fileURLToPath(new URL("./render.mjs", import.meta.url));
const NOW = "2026-01-12T10:00:00Z";
const CLI_BUDGET_MS = Number(process.env.ROADMAP_SELF_TEST_CLI_BUDGET_MS) || 90_000;

process.env.ROADMAP_SELF_TEST = "1";
process.env.ROADMAP_NOW = NOW;
const renderMjs = await import("./render.mjs");
const { renderAll, statusReport, computeLag, registersHash, dayOf } = renderMjs;

const FIXTURE_PREFIX = `render-self-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}-`;
const FIXTURE_DIRS = [];
function newFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  FIXTURE_DIRS.push(dir);
  return dir;
}
function countFixtureTmpDirs() {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX)).length;
}
function cleanupFixtures() {
  const dirs = FIXTURE_DIRS.splice(0);
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fixture dir that refuses to go must never turn a passing run red
    }
  }
  return dirs;
}

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
}
function checkTrue(name, cond, detail) {
  if (!cond) failures++;
  console.log(
    `${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : detail ? `\n        ${detail}` : ""}`,
  );
}

// ── fixtures ─────────────────────────────────────────────────────────────
function writeJsonl(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

function fixtureAFeatures() {
  return [
    {
      id: "F-01",
      name: "Alpha",
      description: "Alpha desc",
      status: "planned",
      percentDone: 0,
      release: "R1",
      targetDate: "2026-01-10",
      area: "roadmap",
      public: true,
      prs: [],
      dependsOn: [],
      ownerLane: "mac",
      machine: "mac",
    },
    {
      id: "F-02",
      name: "Beta",
      description: "Beta desc",
      status: "in-progress",
      percentDone: 40,
      release: "R1",
      targetDate: "2026-01-11",
      area: "roadmap",
      public: true,
      prs: [101],
      dependsOn: [],
      ownerLane: "mac",
      machine: "mac",
    },
    {
      id: "F-03",
      name: "Gamma",
      description: "Gamma desc",
      status: "done",
      percentDone: 100,
      release: "R1",
      targetDate: "2026-01-01",
      area: "roadmap",
      public: true,
      prs: [],
      dependsOn: [],
      ownerLane: "mac",
      machine: "mac",
    },
    {
      id: "F-04",
      name: "Delta",
      description: "Delta desc",
      status: "planned",
      percentDone: 0,
      release: "R2",
      targetDate: "2026-01-12",
      area: "roadmap",
      public: true,
      prs: [],
      dependsOn: [],
      ownerLane: "mac",
      machine: "mac",
    },
  ];
}
function fixtureADeferred() {
  return [
    {
      id: "D-01",
      title: "Deferred one",
      status: "open",
      revisitBy: "2026-01-05",
      owner: "Lead",
      fromFeature: "F-01",
      decidedBy: "Lead",
      decidedOn: "2026-01-01",
      why: "why one",
    },
    {
      id: "D-02",
      title: "Deferred two",
      status: "open",
      revisitBy: "2026-01-20",
      owner: "Lead",
      decidedBy: "Lead",
      decidedOn: "2026-01-01",
      why: "why two",
    },
  ];
}
function fixtureAReleases() {
  return [
    {
      id: "R1",
      name: "Release One",
      shipDate: "2026-01-15",
      status: "in-progress",
      goal: "goal one",
    },
    { id: "R2", name: "Release Two", shipDate: "2026-02-01", status: "planned", goal: "goal two" },
  ];
}
function writeFixtureA(dir) {
  writeJsonl(join(dir, "features.jsonl"), fixtureAFeatures());
  writeJsonl(join(dir, "deferred.jsonl"), fixtureADeferred());
  writeJsonl(join(dir, "releases.jsonl"), fixtureAReleases());
  return dir;
}

const DEFECTS = {
  D1: (f) => ({ ...f, features: [...f.features, f.features[0]] }),
  D2: (f) => ({
    ...f,
    features: f.features.map((x) => (x.id === "F-02" ? { ...x, targetDate: undefined } : x)),
  }),
  D3: (f) => ({
    ...f,
    features: f.features.map((x) => (x.id === "F-01" ? { ...x, dependsOn: ["F-99"] } : x)),
  }),
  D4: (f) => ({
    ...f,
    deferred: f.deferred.map((x) => (x.id === "D-01" ? { ...x, revisitBy: undefined } : x)),
  }),
  D5: (f) => ({
    ...f,
    deferred: f.deferred.map((x) => (x.id === "D-02" ? { ...x, fromFeature: "F-77" } : x)),
  }),
};
const DEFECT_LINES = {
  D1: "duplicate feature id: F-01",
  D2: "feature F-02 is missing targetDate",
  D3: "feature F-01 dependsOn missing feature F-99",
  D4: "deferred D-01 is open but missing revisitBy",
  D5: "deferred D-02 fromFeature points to missing feature F-77",
};
function writeDefect(dir, key) {
  const mutated = DEFECTS[key]({ features: fixtureAFeatures(), deferred: fixtureADeferred() });
  writeJsonl(join(dir, "features.jsonl"), mutated.features);
  writeJsonl(join(dir, "deferred.jsonl"), mutated.deferred);
  writeJsonl(join(dir, "releases.jsonl"), fixtureAReleases());
  return dir;
}

function fixtureB(dir) {
  const features = [];
  for (let i = 1; i <= 60; i++) {
    const id = `F-${String(i).padStart(2, "0")}`;
    features.push({
      id,
      name: `Feature ${id}`,
      description: "d",
      status: "planned",
      percentDone: 0,
      release: "R1",
      targetDate: "2026-01-01",
      area: "roadmap",
      public: false,
      prs: [],
      dependsOn: [],
      ownerLane: "mac",
      machine: "mac",
    });
  }
  writeJsonl(join(dir, "features.jsonl"), features);
  writeJsonl(join(dir, "deferred.jsonl"), []);
  writeJsonl(join(dir, "releases.jsonl"), fixtureAReleases());
  return dir;
}

function fixtureC(dir) {
  const features = [
    ...fixtureAFeatures(),
    {
      id: "F-05",
      name: "Epsilon",
      description: "e",
      status: "planned",
      percentDone: 10,
      release: "R1",
      targetDate: "2026-01-20",
      area: "roadmap",
      public: false,
      prs: [],
      dependsOn: [],
      ownerLane: "mac",
      machine: "mac",
    },
  ];
  writeJsonl(join(dir, "features.jsonl"), features);
  writeJsonl(join(dir, "deferred.jsonl"), fixtureADeferred());
  writeJsonl(join(dir, "releases.jsonl"), fixtureAReleases());
  return dir;
}

function sha256Files(paths) {
  const h = createHash("sha256");
  for (const p of paths) h.update(readFileSync(p));
  return h.digest("hex");
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runCli(argv, { regDir, out, now = NOW, env = {} } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, ROADMAP_SELF_TEST: "1", ROADMAP_NOW: now, ...env };
    if (regDir) childEnv.ROADMAP_REG_DIR = regDir;
    delete childEnv.ROADMAP_REG_DIR_UNSET;
    const args = [SCRIPT_PATH, ...argv];
    if (out && !argv.includes("--out")) args.push("--out", out);
    const child = spawn(process.execPath, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), CLI_BUDGET_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ── T1: --validate defects + OK path ───────────────────────────────────────
async function t1() {
  for (const key of Object.keys(DEFECT_LINES)) {
    const dir = newFixtureDir();
    writeDefect(dir, key);
    const { code, stderr } = await runCli(["--validate"], { regDir: dir });
    checkTrue(`T1 ${key} exits 1`, code === 1, `got code=${code}`);
    checkTrue(
      `T1 ${key} stderr contains its line`,
      stderr.includes(DEFECT_LINES[key]),
      `stderr:\n${stderr}`,
    );
  }
  const okDir = newFixtureDir();
  writeFixtureA(okDir);
  const okRes = await runCli(["--validate"], { regDir: okDir });
  checkTrue(
    "T1 fixture A OK exit 0",
    okRes.code === 0,
    `got code=${okRes.code}, stderr=${okRes.stderr}`,
  );
  checkTrue(
    "T1 fixture A OK stdout shape",
    /^roadmap validate: OK — \d+ features, \d+ deferred, \d+ releases\.$/.test(okRes.stdout.trim()),
    `stdout: ${okRes.stdout}`,
  );
  const realRes = await runCli(["--validate"]);
  checkTrue(
    "T1 real registers exit 0",
    realRes.code === 0,
    `got code=${realRes.code}, stderr=${realRes.stderr}`,
  );
  checkTrue(
    "T1 real registers stdout shape",
    /^roadmap validate: OK — \d+ features, \d+ deferred, \d+ releases\.$/.test(
      realRes.stdout.trim(),
    ),
    `stdout: ${realRes.stdout}`,
  );
}

// ── T2: renderAll lag.json / .rendered.json / tracker.html / statusReport ──
async function t2() {
  const dir = newFixtureDir();
  writeFixtureA(dir);
  const outDir = join(newFixtureDir(), "out");
  const now = NOW;
  const r = renderAll({ outDir, now, dir });
  checkTrue("T2 renderAll no errors", r.errors.length === 0, JSON.stringify(r.errors));

  const lagJson = JSON.parse(readFileSync(join(outDir, "lag.json"), "utf8"));
  check(
    "T2 lag.json features ids",
    lagJson.features.map((f) => f.id),
    ["F-01", "F-02"],
  );
  check(
    "T2 lag.json features daysLate",
    lagJson.features.map((f) => f.daysLate),
    [2, 1],
  );
  check("T2 lag.json deferred", lagJson.deferred, [
    { id: "D-01", revisitBy: "2026-01-05", daysLate: 7 },
  ]);
  check("T2 lag.json day", lagJson.day, "2026-01-12");

  const tracker = readFileSync(join(outDir, "tracker.html"), "utf8");
  const lagSection = tracker.slice(tracker.indexOf("<h2>Lag</h2>"));
  checkTrue("T2 tracker Lag has F-01", lagSection.includes("<b>F-01</b>"));
  checkTrue("T2 tracker Lag has F-02", lagSection.includes("<b>F-02</b>"));
  checkTrue("T2 tracker Lag has D-01", lagSection.includes("<b>D-01</b>"));
  checkTrue("T2 tracker Lag excludes F-03", !lagSection.includes("<b>F-03</b>"));
  checkTrue("T2 tracker Lag excludes F-04", !lagSection.includes("<b>F-04</b>"));

  const rendered = JSON.parse(readFileSync(join(outDir, ".rendered.json"), "utf8"));
  const expectedHash = sha256Files([
    join(dir, "features.jsonl"),
    join(dir, "deferred.jsonl"),
    join(dir, "releases.jsonl"),
  ]);
  check("T2 registersHash independent", rendered.registersHash, expectedHash);
  checkTrue(
    "T2 headSha shape",
    rendered.headSha === null || /^[0-9a-f]{40}$/.test(rendered.headSha),
    `got ${rendered.headSha}`,
  );

  const status = statusReport({ outDir, now, dir });
  check(
    "T2 status LAG line",
    status.lines[1],
    "Roadmap LAG: 2 features past target (F-01 -2d, F-02 -1d) · 1 deferred past revisitBy (D-01 -7d)",
  );
}

// ── T3: idempotence + atomic writes + no-write-on-invalid ──────────────────
async function t3() {
  const regDirPath = newFixtureDir();
  writeFixtureA(regDirPath);
  const outDir = join(newFixtureDir(), "out");
  const r1 = await runCli([], { regDir: regDirPath, out: outDir });
  checkTrue("T3 run1 exit 0", r1.code === 0, `stderr=${r1.stderr}`);
  const files1 = ["roadmap.html", "tracker.html", "deferred.html", "lag.json", ".rendered.json"];
  const shas1 = Object.fromEntries(files1.map((f) => [f, sha256File(join(outDir, f))]));

  const r2 = await runCli([], { regDir: regDirPath, out: outDir });
  checkTrue("T3 run2 exit 0", r2.code === 0, `stderr=${r2.stderr}`);
  const shas2 = Object.fromEntries(files1.map((f) => [f, sha256File(join(outDir, f))]));
  check("T3 run2 byte-identical to run1", shas2, shas1);
  const tmpEntries = readdirSync(outDir).filter((n) => n.includes(".tmp-"));
  check("T3 no tmp entries after run2", tmpEntries, []);

  const defectDir = newFixtureDir();
  writeDefect(defectDir, "D1");
  const r3 = await runCli([], { regDir: defectDir, out: outDir });
  checkTrue("T3 D1 run exit 1", r3.code === 1, `got code=${r3.code}`);
  checkTrue(
    "T3 D1 stderr starts with render: registers fail validation",
    r3.stderr.startsWith("render: registers fail validation"),
    r3.stderr,
  );
  const shas3 = Object.fromEntries(files1.map((f) => [f, sha256File(join(outDir, f))]));
  check("T3 files unchanged after invalid run", shas3, shas1);
}

// ── T4: statusReport render/publish lines, exact strings per render-dir state ──
async function t4() {
  const regDirPath = newFixtureDir();
  writeFixtureA(regDirPath);
  const now = NOW;
  const currentHash = registersHash(regDirPath);
  const hash7 = currentHash.slice(0, 7);

  // state: dir absent
  {
    const outDir = join(newFixtureDir(), "absent");
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check(
      "T4 dir-absent line3",
      s.lines[2],
      `Roadmap render: never rendered on this machine (no ${join(outDir, ".rendered.json")}) → node scripts/roadmap/render.mjs`,
    );
    check(
      "T4 dir-absent line4 hasKey",
      s.lines[3],
      "Roadmap publish: never published on this machine → npm run roadmap:publish",
    );
    const sNoKey = statusReport({ outDir, now, hasKey: false, dir: regDirPath });
    check(
      "T4 dir-absent line4 noKey",
      sNoKey.lines[3],
      "Roadmap publish: no PLANE_API_KEY on this machine — the PC's hourly job publishes",
    );
  }

  // state: 3 HTML files, no stamp
  {
    const outDir = newFixtureDir();
    for (const f of ["roadmap.html", "tracker.html", "deferred.html"])
      writeFileSync(join(outDir, f), "x");
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check(
      "T4 no-stamp line3",
      s.lines[2],
      "Roadmap render: STALE — no stamp (regenerate once to stamp it) → node scripts/roadmap/render.mjs",
    );
  }

  // state: stamp registersHash != current
  {
    const outDir = newFixtureDir();
    for (const f of ["roadmap.html", "tracker.html", "deferred.html"])
      writeFileSync(join(outDir, f), "x");
    const staleHash = "a".repeat(64);
    writeFileSync(
      join(outDir, ".rendered.json"),
      JSON.stringify({
        renderedAt: "2026-01-11T09:00:00.000Z",
        day: "2026-01-11",
        registersHash: staleHash,
        headSha: null,
      }),
    );
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check(
      "T4 hash-mismatch line3",
      s.lines[2],
      `Roadmap render: STALE — rendered 2026-01-11T09:00:00.000Z (day 2026-01-11, registers ${staleHash.slice(0, 7)}) but registers are now ${hash7} → node scripts/roadmap/render.mjs`,
    );
  }

  // state: stamp hash equal, day mismatch (yesterday)
  {
    const outDir = newFixtureDir();
    for (const f of ["roadmap.html", "tracker.html", "deferred.html"])
      writeFileSync(join(outDir, f), "x");
    writeFileSync(
      join(outDir, ".rendered.json"),
      JSON.stringify({
        renderedAt: "2026-01-11T09:00:00.000Z",
        day: "2026-01-11",
        registersHash: currentHash,
        headSha: null,
      }),
    );
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check(
      "T4 day-mismatch line3",
      s.lines[2],
      `Roadmap render: STALE — rendered 2026-01-11T09:00:00.000Z (day 2026-01-11, registers ${hash7}) but today is 2026-01-12 → node scripts/roadmap/render.mjs`,
    );
  }

  // state: stamp fresh but tracker.html deleted
  {
    const outDir = newFixtureDir();
    for (const f of ["roadmap.html", "deferred.html"]) writeFileSync(join(outDir, f), "x");
    writeFileSync(
      join(outDir, ".rendered.json"),
      JSON.stringify({
        renderedAt: now,
        day: "2026-01-12",
        registersHash: currentHash,
        headSha: null,
      }),
    );
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check(
      "T4 tracker-missing line3",
      s.lines[2],
      "Roadmap render: STALE — tracker.html missing → node scripts/roadmap/render.mjs",
    );
  }

  // state: fully fresh, .published.json fresh, target pages
  {
    const outDir = newFixtureDir();
    for (const f of ["roadmap.html", "tracker.html", "deferred.html"])
      writeFileSync(join(outDir, f), "x");
    writeFileSync(
      join(outDir, ".rendered.json"),
      JSON.stringify({
        renderedAt: now,
        day: "2026-01-12",
        registersHash: currentHash,
        headSha: null,
      }),
    );
    writeFileSync(
      join(outDir, ".published.json"),
      JSON.stringify({
        publishedAt: now,
        day: "2026-01-12",
        registersHash: currentHash,
        target: "pages",
      }),
    );
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check("T4 fresh line3", s.lines[2], `Roadmap render: fresh (${now}, registers ${hash7})`);
    check("T4 fresh line4 hasKey", s.lines[3], `Roadmap publish: fresh (${now}, target pages)`);
    const sNoKey = statusReport({ outDir, now, hasKey: false, dir: regDirPath });
    check(
      "T4 fresh line4 noKey (stamp beats key hint)",
      sNoKey.lines[3],
      `Roadmap publish: fresh (${now}, target pages)`,
    );
  }

  // state: malformed .rendered.json
  {
    const outDir = newFixtureDir();
    for (const f of ["roadmap.html", "tracker.html", "deferred.html"])
      writeFileSync(join(outDir, f), "x");
    writeFileSync(join(outDir, ".rendered.json"), "not json{");
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check(
      "T4 malformed-stamp treated as no-stamp",
      s.lines[2],
      "Roadmap render: STALE — no stamp (regenerate once to stamp it) → node scripts/roadmap/render.mjs",
    );
  }

  // line 1 (counts) and totals, on the fully-fresh dir above
  {
    const outDir = newFixtureDir();
    const s = statusReport({ outDir, now, hasKey: true, dir: regDirPath });
    check(
      "T4 line1 counts",
      s.lines[0],
      "Roadmap: 4 features (1 in-progress · 2 planned · 0 at-risk · 1 done) · 2 deferred (2 open) · next: R1 ships 2026-01-15",
    );
    checkTrue(
      "T4 every line starts with Roadmap",
      s.lines.every((l) => l.startsWith("Roadmap")),
      JSON.stringify(s.lines),
    );
    check("T4 total lines", s.lines.length, 4);
  }
}

// ── T5: byte cap + truncation on fixture B ──────────────────────────────────
async function t5() {
  const dir = newFixtureDir();
  fixtureB(dir);
  const outDir = newFixtureDir();
  const s = statusReport({ outDir, now: NOW, hasKey: true, dir });
  checkTrue(
    "T5 byte cap",
    Buffer.byteLength(s.lines.join("\n"), "utf8") <= 768,
    `bytes=${Buffer.byteLength(s.lines.join("\n"), "utf8")}`,
  );
  checkTrue("T5 line count cap", s.lines.length <= 5, `lines=${s.lines.length}`);
  const lagLine = s.lines[1];
  checkTrue(
    "T5 line2 has +N more",
    /, \+\d+ more\) · 0 deferred past revisitBy$/.test(lagLine),
    lagLine,
  );
  checkTrue("T5 line1 untruncated", s.lines[0].startsWith("Roadmap: 60 features ("), s.lines[0]);
}

// ── T6: --status never fails, 4 states ──────────────────────────────────────
async function t6() {
  // (a) defect D1+D2 dir (2 problems)
  {
    const dir = newFixtureDir();
    const mutated = DEFECTS.D2(
      DEFECTS.D1({ features: fixtureAFeatures(), deferred: fixtureADeferred() }),
    );
    writeJsonl(join(dir, "features.jsonl"), mutated.features);
    writeJsonl(join(dir, "deferred.jsonl"), mutated.deferred);
    writeJsonl(join(dir, "releases.jsonl"), fixtureAReleases());
    const outDir = newFixtureDir();
    const { code, stdout } = await runCli(["--status"], { regDir: dir, out: outDir });
    checkTrue("T6a exit 0", code === 0, `got ${code}`);
    const lines = stdout.trimEnd().split("\n");
    checkTrue("T6a <=5 lines", lines.length <= 5, `lines=${lines.length}`);
    check(
      "T6a line1",
      lines[0],
      "Roadmap: registers INVALID (2 problems) → node scripts/roadmap/render.mjs --validate",
    );
    checkTrue(
      "T6a has render line",
      lines.some((l) => l.startsWith("Roadmap render:")),
      stdout,
    );
    checkTrue(
      "T6a has publish line",
      lines.some((l) => l.startsWith("Roadmap publish:")),
      stdout,
    );
  }
  // (b) features.jsonl deleted (loadRegisters throws unreadable)
  {
    const dir = newFixtureDir();
    writeJsonl(join(dir, "deferred.jsonl"), []);
    writeJsonl(join(dir, "releases.jsonl"), []);
    const outDir = newFixtureDir();
    const { code, stdout } = await runCli(["--status"], { regDir: dir, out: outDir });
    checkTrue("T6b exit 0", code === 0, `got ${code}`);
    check(
      "T6b line1",
      stdout.trimEnd().split("\n")[0],
      `Roadmap: registers unreadable (${join(dir, "features.jsonl")})`,
    );
  }
  // (c) --out pointing at a non-existent dir
  {
    const dir = newFixtureDir();
    writeFixtureA(dir);
    const outDir = join(newFixtureDir(), "does-not-exist");
    const { code, stdout } = await runCli(["--status"], { regDir: dir, out: outDir });
    checkTrue("T6c exit 0", code === 0, `got ${code}`);
    checkTrue(
      "T6c contains never-rendered line",
      stdout.includes(
        `Roadmap render: never rendered on this machine (no ${join(outDir, ".rendered.json")}) → node scripts/roadmap/render.mjs`,
      ),
      stdout,
    );
  }
  // (d) fixture A + ROADMAP_STATUS_THROW=1
  {
    const dir = newFixtureDir();
    writeFixtureA(dir);
    const outDir = newFixtureDir();
    const { code, stdout } = await runCli(["--status"], {
      regDir: dir,
      out: outDir,
      env: { ROADMAP_STATUS_THROW: "1" },
    });
    checkTrue("T6d exit 0", code === 0, `got ${code}`);
    check("T6d stdout", stdout.trimEnd(), "Roadmap: status failed (self-test throw)");
  }
}

// ── T7: statusReport on real registers, budget ──────────────────────────────
async function t7() {
  const budget = Number(process.env.ROADMAP_SELF_TEST_STATUS_BUDGET_MS) || 300;
  const outDir = newFixtureDir();
  renderAll({ outDir, now: NOW });
  const start = performance.now();
  const s = statusReport({ outDir, now: NOW });
  const elapsed = performance.now() - start;
  checkTrue(
    `T7 statusReport under budget (${elapsed.toFixed(1)}ms < ${budget}ms)`,
    elapsed < budget,
    `elapsed=${elapsed}`,
  );
  checkTrue(
    "T7 statusReport returned lines",
    Array.isArray(s.lines) && s.lines.length > 0,
    JSON.stringify(s),
  );
}

// ── T8: validateWarnings, fixture C ───────────────────────────────────────
async function t8() {
  const dir = newFixtureDir();
  fixtureC(dir);
  const { code, stderr } = await runCli(["--validate"], { regDir: dir });
  checkTrue("T8 exit 0", code === 0, `got ${code}, stderr=${stderr}`);
  const warnLines = stderr.trim().split("\n").filter(Boolean);
  check("T8 warn count", warnLines.length, 2);
  checkTrue(
    "T8 warn F-05",
    warnLines.includes("warn: F-05 targetDate 2026-01-20 is after R1 ships 2026-01-15"),
    stderr,
  );
  checkTrue(
    "T8 warn F-01",
    warnLines.includes("warn: F-01 is past its targetDate (2026-01-10) but still planned at 0%"),
    stderr,
  );

  const real = await runCli(["--validate"]);
  checkTrue("T8 real registers exit 0 whatever warns", real.code === 0, `got ${real.code}`);
}

// ── T9: --status under a no-network stub ──────────────────────────────────
async function t9() {
  const stubDir = newFixtureDir();
  const stubPath = join(stubDir, "no-net.mjs");
  writeFileSync(stubPath, 'globalThis.fetch = () => { throw new Error("network forbidden"); };\n');
  const dir = newFixtureDir();
  writeFixtureA(dir);
  const outDir = newFixtureDir();
  await new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      ROADMAP_SELF_TEST: "1",
      ROADMAP_NOW: NOW,
      ROADMAP_REG_DIR: dir,
    };
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(stubPath).href, SCRIPT_PATH, "--status", "--out", outDir],
      {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), CLI_BUDGET_MS);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      clearTimeout(timer);
      checkTrue("T9 exit 0", code === 0, `got ${code}, stderr=${stderr}`);
      const lines = stdout.trimEnd().split("\n");
      check("T9 line count", lines.length, 4);
      checkTrue(
        "T9 all lines start with Roadmap",
        lines.every((l) => l.startsWith("Roadmap")),
        stdout,
      );
      resolve();
    });
  });
}

// ── T10: --help / -h / --bogus ──────────────────────────────────────────────
async function t10() {
  for (const flag of ["--help", "-h"]) {
    const { code, stdout } = await runCli([flag]);
    checkTrue(`T10 ${flag} exit 0`, code === 0, `got ${code}`);
    checkTrue(`T10 ${flag} stdout starts Usage`, stdout.startsWith("Usage: render.mjs"), stdout);
  }
  const bogus = await runCli(["--bogus"]);
  checkTrue("T10 --bogus exit 2", bogus.code === 2, `got ${bogus.code}`);
  checkTrue(
    "T10 --bogus stderr starts Usage",
    bogus.stderr.startsWith("Usage: render.mjs"),
    bogus.stderr,
  );
}

// ── T10v (#2273): `npm run verify` runs this self-test ────────────────────────
// Unwired, this file protects nothing (the #2271 review found WP2's sibling orphaned), so it pins
// its own place in the root verify chain, the way google-signin-check's T8 does.
function t10v() {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
  );
  const verify = typeof pkg.scripts?.verify === "string" ? pkg.scripts.verify : "";
  checkTrue(
    "T10v verify chain runs scripts/roadmap/render.self-test.mjs",
    verify.split("&&").some((step) => step.trim() === "node scripts/roadmap/render.self-test.mjs"),
    "not found as its own `&&` step in package.json scripts.verify",
  );
}

async function main() {
  console.log("render.self-test");
  await t1();
  await t2();
  await t3();
  await t4();
  await t5();
  await t6();
  await t7();
  await t8();
  await t9();
  await t10();
  t10v();
}

try {
  await main();
} catch (err) {
  failures++;
  console.log(`  FAIL render.self-test threw: ${err?.stack ?? err}`);
} finally {
  const leftover = cleanupFixtures();
  const remaining = countFixtureTmpDirs();
  if (remaining) {
    console.log(`  note: ${remaining} fixture tmp dir(s) still present after cleanup (non-fatal)`);
  }
  void leftover;
}

const elapsedTotal = performance.now() - t0;
if (process.env.ROADMAP_SELF_TEST_BUDGET_MS) {
  const budgetTotal = Number(process.env.ROADMAP_SELF_TEST_BUDGET_MS);
  checkTrue(
    `T36 wall-clock under budget (${elapsedTotal.toFixed(1)}ms < ${budgetTotal}ms)`,
    elapsedTotal < budgetTotal,
    `elapsed=${elapsedTotal}`,
  );
} else {
  // Opt-in only (fleet lead ruling 2026-09-24): a wall-clock assertion in a self-test that
  // `verify` runs will flake on every loaded host. Unset -> advisory line, never a failure.
  console.log(
    `  info  T36 wall-clock ${elapsedTotal.toFixed(1)}ms (no ROADMAP_SELF_TEST_BUDGET_MS set — advisory only)`,
  );
}

console.log(
  failures
    ? `\nrender.self-test: ${failures} FAILURE(S) (${elapsedTotal.toFixed(0)}ms)`
    : `\nrender.self-test: ok (${elapsedTotal.toFixed(0)}ms)`,
);
process.exit(failures ? 1 : 0);
