#!/usr/bin/env node
// Self-test for scripts/visibility-deadman.mjs — plain node, no Jest, no network, no real `gh`.
//
//   node scripts/visibility-deadman.self-test.mjs
//
// Every case runs the real script as a child process against a STUB gh (via the test-only
// VISIBILITY_DEADMAN_GH_BIN hook) and a scratch --state-dir under the OS temp dir, so nothing here
// can touch the real local-assets/ or the real repo. Exit 0 = all cases passed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "visibility-deadman.mjs");
const REPO = "acme/example";

// ─── the stub gh ──────────────────────────────────────────────────────────────────────────────
// Behaviour comes from files in $STUB_DIR so each case just rewrites them:
//   visibility.txt   what `repo view` reports (PUBLIC | PRIVATE)
//   view-fail        if it exists, `repo view` exits 1 (network/auth failure)
//   edit-mode.txt    "flip" (edit really makes it PRIVATE) | "noop" (edit "succeeds", nothing changes)
//   calls.log        one line per invocation, so a case can assert "never flipped"
const STUB_MJS = `
import fs from "node:fs";
import path from "node:path";
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\\n");
const read = (f, d) => { try { return fs.readFileSync(path.join(dir, f), "utf8").trim(); } catch { return d; } };
if (args[0] === "repo" && args[1] === "view") {
  if (fs.existsSync(path.join(dir, "view-fail"))) { console.error("HTTP 502: bad gateway"); process.exit(1); }
  console.log(JSON.stringify({ visibility: read("visibility.txt", "PRIVATE") }));
} else if (args[0] === "repo" && args[1] === "edit") {
  if (read("edit-mode.txt", "flip") === "flip") fs.writeFileSync(path.join(dir, "visibility.txt"), "PRIVATE");
} else {
  console.error("stub gh: unexpected args " + args.join(" ")); process.exit(9);
}
`;

function makeStub(dir) {
  fs.writeFileSync(path.join(dir, "stub.mjs"), STUB_MJS);
  const node = process.execPath;
  if (process.platform === "win32") {
    const bin = path.join(dir, "gh-stub.cmd");
    fs.writeFileSync(bin, `@echo off\r\n"${node}" "${path.join(dir, "stub.mjs")}" %*\r\n`);
    return bin;
  }
  const bin = path.join(dir, "gh-stub.sh");
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${node}" "${path.join(dir, "stub.mjs")}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

// ─── harness ──────────────────────────────────────────────────────────────────────────────────
let failures = 0;
const sandboxes = [];

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vis-deadman-"));
  sandboxes.push(root);
  const stubDir = path.join(root, "stub");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stubDir);
  const bin = makeStub(stubDir);
  const set = (name, value) => fs.writeFileSync(path.join(stubDir, name), value);
  return {
    stateDir,
    stateFile: path.join(stateDir, "visibility-deadman.state.json"),
    logFile: path.join(stateDir, "visibility-deadman.log"),
    visibility: (v) => set("visibility.txt", v),
    editMode: (m) => set("edit-mode.txt", m),
    viewFails: () => set("view-fail", "1"),
    calls: () => {
      try {
        return fs.readFileSync(path.join(stubDir, "calls.log"), "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    state: () =>
      JSON.parse(fs.readFileSync(path.join(stateDir, "visibility-deadman.state.json"), "utf8")),
    writeState: (s) => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "visibility-deadman.state.json"), JSON.stringify(s));
    },
    logLines: () => {
      try {
        return fs
          .readFileSync(path.join(stateDir, "visibility-deadman.log"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    run: (args, extraEnv = {}) =>
      spawnSync(process.execPath, [SCRIPT, ...args], {
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...process.env,
          VISIBILITY_DEADMAN_GH_BIN: bin,
          VISIBILITY_DEADMAN_RETRY_DELAYS_MS: "[10,10,10,10,10]",
          STUB_DIR: stubDir,
          ...extraEnv,
        },
      }),
  };
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

function test(name, fn) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL - ${name}\n       ${err.message}`);
  }
}

const base = (sb, extra = []) => ["--once", "--repo", REPO, "--state-dir", sb.stateDir, ...extra];
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

// ─── cases ────────────────────────────────────────────────────────────────────────────────────
test("unknown flag exits 2 with usage and creates no files and makes no gh call", () => {
  const sb = sandbox();
  const r = sb.run(["--once", "--bogus", "--state-dir", sb.stateDir]);
  check(r.status === 2, `want exit 2, got ${r.status}`);
  check(/usage:/.test(r.stderr), "usage not printed");
  check(!fs.existsSync(sb.stateDir), "state dir was created");
  check(sb.calls().length === 0, "gh was called");
});

test("bad values exit 2 before any side effect", () => {
  for (const bad of [
    ["--max-public-minutes", "0"],
    ["--max-public-minutes", "abc"],
    ["--interval-seconds", "-5"],
    ["--repo", "no-slash"],
    ["--repo"],
  ]) {
    const sb = sandbox();
    const r = sb.run(["--once", "--state-dir", sb.stateDir, ...bad]);
    check(r.status === 2, `${bad.join(" ")}: want exit 2, got ${r.status}`);
    check(!fs.existsSync(sb.stateDir), `${bad.join(" ")}: state dir was created`);
    check(sb.calls().length === 0, `${bad.join(" ")}: gh was called`);
  }
});

test("--help exits 0 and creates nothing", () => {
  const sb = sandbox();
  const r = sb.run(["--help", "--state-dir", sb.stateDir]);
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(/usage:/.test(r.stdout), "usage not printed");
  check(!fs.existsSync(sb.stateDir) && sb.calls().length === 0, "side effect from --help");
});

test("the gh test hook prints a WARNING line", () => {
  const sb = sandbox();
  sb.visibility("PRIVATE");
  const r = sb.run(base(sb));
  check(/WARNING: test hook VISIBILITY_DEADMAN_GH_BIN/.test(r.stderr), "no WARNING on stderr");
});

test("PRIVATE clears firstSeenPublicAt and writes a heartbeat", () => {
  const sb = sandbox();
  sb.visibility("PRIVATE");
  sb.writeState({
    firstSeenPublicAt: minutesAgo(30),
    lastCheckAt: minutesAgo(2),
    lastVisibility: "PUBLIC",
  });
  const r = sb.run(base(sb));
  check(r.status === 0, `want exit 0, got ${r.status}: ${r.stderr}`);
  const s = sb.state();
  check(s.firstSeenPublicAt === null, "firstSeenPublicAt not cleared");
  check(s.lastVisibility === "PRIVATE" && s.lastCheckAt, "lastVisibility/lastCheckAt not set");
  check(
    sb.logLines().some((l) => l.event === "heartbeat" && l.ok === true),
    "no heartbeat line",
  );
  check(!sb.calls().some((c) => c.startsWith("repo edit")), "flipped a private repo");
});

test("first PUBLIC poll sets the timer and does not flip", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  const r = sb.run(base(sb));
  check(r.status === 0, `want exit 0, got ${r.status}: ${r.stderr}`);
  const s = sb.state();
  check(Number.isFinite(Date.parse(s.firstSeenPublicAt)), "firstSeenPublicAt not set");
  check(Date.now() - Date.parse(s.firstSeenPublicAt) < 60_000, "firstSeenPublicAt is not ~now");
  check(s.lastVisibility === "PUBLIC", "lastVisibility not PUBLIC");
  check(!sb.calls().some((c) => c.startsWith("repo edit")), "flipped on first sight");
});

test("PUBLIC under the limit keeps the original timer and does not flip", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  const since = minutesAgo(30);
  sb.writeState({ firstSeenPublicAt: since, lastCheckAt: minutesAgo(2), lastVisibility: "PUBLIC" });
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(sb.state().firstSeenPublicAt === since, "timer was reset");
  check(!sb.calls().some((c) => c.startsWith("repo edit")), "flipped under the limit");
});

test("PUBLIC past the limit flips private, verifies, logs an incident, clears the timer", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.editMode("flip");
  sb.writeState({
    firstSeenPublicAt: minutesAgo(90),
    lastCheckAt: minutesAgo(2),
    lastVisibility: "PUBLIC",
  });
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 0, `want exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
  const edits = sb.calls().filter((c) => c.startsWith("repo edit"));
  check(edits.length === 1, `want 1 edit, got ${edits.length}`);
  check(
    edits[0] === `repo edit ${REPO} --visibility private --accept-visibility-change-consequences`,
    `wrong edit argv: ${edits[0]}`,
  );
  const incident = sb.logLines().find((l) => l.event === "incident");
  check(
    incident && incident.confirmed === true && incident.action === "flipped-private",
    "no confirmed incident line",
  );
  check(sb.state().firstSeenPublicAt === null, "timer not cleared after confirmed flip");
});

test("flip whose read-back stays PUBLIC retries, exits 1, logs an unconfirmed incident, keeps the timer", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.editMode("noop");
  const since = minutesAgo(90);
  sb.writeState({ firstSeenPublicAt: since, lastCheckAt: minutesAgo(2), lastVisibility: "PUBLIC" });
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 1, `want exit 1, got ${r.status}`);
  const edits = sb.calls().filter((c) => c.startsWith("repo edit"));
  check(edits.length === 6, `want 6 flip attempts, got ${edits.length}`);
  const incident = sb.logLines().find((l) => l.event === "incident");
  check(
    incident && incident.confirmed === false && incident.attempts === 6,
    "no unconfirmed incident line",
  );
  check(sb.state().firstSeenPublicAt === since, "timer was cleared despite unconfirmed flip");
});

test("gh failure exits non-zero, never flips, and keeps state", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.viewFails();
  const s0 = {
    firstSeenPublicAt: minutesAgo(90),
    lastCheckAt: minutesAgo(2),
    lastVisibility: "PUBLIC",
  };
  sb.writeState(s0);
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 4, `want exit 4, got ${r.status}`);
  check(!sb.calls().some((c) => c.startsWith("repo edit")), "flipped on an unreadable poll");
  const s = sb.state();
  check(s.firstSeenPublicAt === s0.firstSeenPublicAt, "firstSeenPublicAt changed");
  check(
    s.lastCheckAt === s0.lastCheckAt && s.lastVisibility === "PUBLIC",
    "lastCheckAt/visibility changed",
  );
  check(
    sb.logLines().some((l) => l.event === "heartbeat" && l.ok === false),
    "no failed heartbeat",
  );
});

test("gh failure with no prior state does not start the timer", () => {
  const sb = sandbox();
  sb.viewFails();
  const r = sb.run(base(sb));
  check(r.status === 4, `want exit 4, got ${r.status}`);
  check(sb.state().firstSeenPublicAt === null, "timer started from an unreadable poll");
});

test("--status prints state and heartbeat age, exits 0, makes no gh call and writes nothing", () => {
  const sb = sandbox();
  sb.writeState({
    firstSeenPublicAt: minutesAgo(10),
    lastCheckAt: minutesAgo(1),
    lastVisibility: "PUBLIC",
  });
  const before = fs.readFileSync(sb.stateFile, "utf8");
  const r = sb.run(["--status", "--state-dir", sb.stateDir]);
  check(r.status === 0, `want exit 0, got ${r.status}`);
  const out = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf("}") + 1));
  check(out.stateFound === true && out.state.lastVisibility === "PUBLIC", "state not printed");
  check(out.lastCheckAgeSeconds >= 50 && out.lastCheckAgeSeconds < 300, "bad heartbeat age");
  check(sb.calls().length === 0, "--status called gh");
  check(fs.readFileSync(sb.stateFile, "utf8") === before, "--status modified the state");
  check(!fs.existsSync(sb.logFile), "--status wrote a log");
});

// ─── cleanup + verdict ────────────────────────────────────────────────────────────────────────
for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("\nall visibility-deadman self-tests passed");
