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
//   permission.txt   viewerPermission `repo view` reports (default ADMIN)
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
  console.log(JSON.stringify({ visibility: read("visibility.txt", "PRIVATE"), viewerPermission: read("permission.txt", "ADMIN") }));
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
    permission: (v) => set("permission.txt", v),
    editMode: (m) => set("edit-mode.txt", m),
    writeRawState: (text) => {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, "visibility-deadman.state.json"), text);
    },
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

// ─── review round 1 ───────────────────────────────────────────────────────────────────────────
// 1. wrong/non-admin gh account must be LOUD, never a silent no-op.
test("non-admin gh: PUBLIC past the limit logs a not-admin incident, exits 5, never flips", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.permission("WRITE");
  sb.writeState({
    firstSeenPublicAt: minutesAgo(90),
    lastCheckAt: minutesAgo(2),
    lastVisibility: "PUBLIC",
  });
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 5, `want exit 5, got ${r.status}`);
  check(
    sb.calls().some((c) => c.includes("--json visibility,viewerPermission")),
    "repo view did not ask for viewerPermission",
  );
  check(!sb.calls().some((c) => c.startsWith("repo edit")), "tried to flip without admin");
  const inc = sb.logLines().find((l) => l.event === "incident" && l.reason === "not-admin");
  check(inc && inc.viewerPermission === "WRITE", "no not-admin incident line");
  check(sb.state().lastPollOk === false, "state does not record the failed poll");
});

test("non-admin gh is loud even while PRIVATE (the flip would fail later)", () => {
  const sb = sandbox();
  sb.visibility("PRIVATE");
  sb.permission("READ");
  const r = sb.run(base(sb));
  check(r.status === 5, `want exit 5, got ${r.status}`);
  check(
    sb.logLines().some((l) => l.event === "incident" && l.reason === "not-admin"),
    "no not-admin incident line",
  );
});

// 1b. --status must say so, with a non-zero exit, in each unhealthy shape.
const statusOf = (sb) => sb.run(["--status", "--state-dir", sb.stateDir]);
const OK_STATE = () => ({
  firstSeenPublicAt: null,
  lastCheckAt: minutesAgo(1),
  lastAttemptAt: minutesAgo(1),
  lastVisibility: "PRIVATE",
  lastPollOk: true,
});

test("--status WARNs and exits 3 when lastCheckAt is older than 600 s", () => {
  const sb = sandbox();
  sb.writeState({ ...OK_STATE(), lastCheckAt: minutesAgo(11), lastAttemptAt: minutesAgo(1) });
  const r = statusOf(sb);
  check(r.status === 3, `want exit 3, got ${r.status}`);
  check(/WARNING/.test(r.stdout), "no WARNING line");
});

test("--status WARNs and exits 3 when the last flip is unconfirmed", () => {
  const sb = sandbox();
  sb.writeState({ ...OK_STATE(), lastFlipConfirmed: false });
  const r = statusOf(sb);
  check(r.status === 3 && /WARNING/.test(r.stdout), `want WARN+3, got ${r.status}`);
});

test("--status WARNs and exits 3 when the last poll failed", () => {
  const sb = sandbox();
  sb.writeState({ ...OK_STATE(), lastPollOk: false, lastPollError: "gh repo view exit=1" });
  const r = statusOf(sb);
  check(r.status === 3 && /WARNING/.test(r.stdout), `want WARN+3, got ${r.status}`);
});

test("--status WARNs and exits 3 when there is no state at all", () => {
  const sb = sandbox();
  const r = statusOf(sb);
  check(r.status === 3 && /WARNING/.test(r.stdout), `want WARN+3, got ${r.status}`);
});

test("--status exits 3 after a real unconfirmed flip, and after a real not-admin poll", () => {
  const a = sandbox();
  a.visibility("PUBLIC");
  a.editMode("noop");
  a.writeState({ ...OK_STATE(), firstSeenPublicAt: minutesAgo(90), lastVisibility: "PUBLIC" });
  check(a.run(base(a, ["--max-public-minutes", "60"])).status === 1, "flip should be unconfirmed");
  check(statusOf(a).status === 3, "status healthy after an unconfirmed flip");
  const b = sandbox();
  b.permission("READ");
  b.run(base(b));
  check(statusOf(b).status === 3, "status healthy after a not-admin poll");
});

test("--status exits 0 for a healthy state", () => {
  const sb = sandbox();
  sb.writeState(OK_STATE());
  const r = statusOf(sb);
  check(r.status === 0 && !/WARNING/.test(r.stdout), `want clean 0, got ${r.status}`);
});

// 2. a gap (gh errors, sleep) must not hand a public repo a fresh 60 minutes.
test("first PUBLIC sighting after a gap backdates firstSeenPublicAt to lastCheckAt", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  const last = minutesAgo(30);
  sb.writeState({ firstSeenPublicAt: null, lastCheckAt: last, lastVisibility: "PRIVATE" });
  const r = sb.run(base(sb));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(sb.state().firstSeenPublicAt === last, "not backdated to lastCheckAt");
});

test("a gap past the limit flips immediately on the first PUBLIC sighting", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.writeState({
    firstSeenPublicAt: null,
    lastCheckAt: minutesAgo(90),
    lastVisibility: "PRIVATE",
  });
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(
    sb.calls().some((c) => c.startsWith("repo edit")),
    "did not flip after a long gap",
  );
});

test("no backdating inside 2x the interval (a normal poll cadence starts at now)", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.writeState({
    firstSeenPublicAt: null,
    lastCheckAt: minutesAgo(2),
    lastVisibility: "PRIVATE",
  });
  const r = sb.run(base(sb));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(Date.now() - Date.parse(sb.state().firstSeenPublicAt) < 60_000, "backdated needlessly");
});

// 4. a corrupt state file must never silently hand out a fresh timer.
test("corrupt state, salvageable lastCheckAt: timer starts at lastCheckAt and is logged", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  const last = minutesAgo(10);
  sb.writeRawState(`{"lastCheckAt":"${last}","firstSeenPu`);
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(sb.state().firstSeenPublicAt === last, "timer not started at the salvaged lastCheckAt");
  check(
    sb.logLines().some((l) => l.event === "error" && /corrupt/i.test(l.detail)),
    "corruption not logged",
  );
});

test("corrupt state, nothing salvageable, PUBLIC: flips now", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.writeRawState("garbage");
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(
    sb.calls().some((c) => c.startsWith("repo edit")),
    "did not flip on unrecoverable state",
  );
  check(
    sb.logLines().some((l) => l.event === "error" && /corrupt/i.test(l.detail)),
    "corruption not logged",
  );
});

test("corrupt state, salvaged lastCheckAt older than the limit: flips", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  sb.writeRawState(`{"lastCheckAt":"${minutesAgo(120)}", oops`);
  const r = sb.run(base(sb, ["--max-public-minutes", "60"]));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(
    sb.calls().some((c) => c.startsWith("repo edit")),
    "did not flip",
  );
});

test("an unparseable firstSeenPublicAt is corruption, not a silent reset to now", () => {
  const sb = sandbox();
  sb.visibility("PUBLIC");
  const last = minutesAgo(1);
  sb.writeState({ firstSeenPublicAt: "banana", lastCheckAt: last, lastVisibility: "PUBLIC" });
  const r = sb.run(base(sb));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(sb.state().firstSeenPublicAt === last, "timer not taken from lastCheckAt");
  check(
    sb.logLines().some((l) => l.event === "error" && /corrupt/i.test(l.detail)),
    "corruption not logged",
  );
});

test("corrupt state while PRIVATE is logged and recovers to a clean state", () => {
  const sb = sandbox();
  sb.visibility("PRIVATE");
  sb.writeRawState("garbage");
  const r = sb.run(base(sb));
  check(r.status === 0, `want exit 0, got ${r.status}`);
  check(sb.state().firstSeenPublicAt === null, "state not recovered");
  check(
    sb.logLines().some((l) => l.event === "error" && /corrupt/i.test(l.detail)),
    "corruption not logged",
  );
});

// 3. the install artefacts: LaunchDaemon (recommended) + wrapper that reads GH_TOKEN from a file.
test("LaunchDaemon plist + wrapper exist, run at boot, and never embed a token", () => {
  const dir = path.join(__dirname, "launchd");
  const daemon = path.join(dir, "com.routeflow.visibility-deadman.daemon.plist");
  const wrapper = path.join(dir, "visibility-deadman-run.sh");
  check(fs.existsSync(daemon), "daemon plist missing");
  check(fs.existsSync(wrapper), "wrapper script missing");
  const plist = fs.readFileSync(daemon, "utf8");
  check(/<key>StartInterval<\/key>\s*<integer>120<\/integer>/.test(plist), "no StartInterval 120");
  check(/<key>RunAtLoad<\/key>\s*<true\/>/.test(plist), "no RunAtLoad");
  check(plist.includes("visibility-deadman-run.sh"), "plist does not run the wrapper");
  check(plist.includes("__TOKEN_FILE__"), "token file placeholder missing");
  check(!/ghp_|github_pat_|<key>GH_TOKEN<\/key>/.test(plist), "plist embeds a token");
  const sh = fs.readFileSync(wrapper, "utf8");
  check(/GH_TOKEN/.test(sh) && /--once/.test(sh), "wrapper must export GH_TOKEN and run --once");
  const agent = fs.readFileSync(path.join(dir, "com.routeflow.visibility-deadman.plist"), "utf8");
  check(/FALLBACK/.test(agent) && /auto-login/i.test(agent), "agent plist not marked as fallback");
});

test("wrapper parses under sh and refuses a missing token file with exit 78", () => {
  const wrapper = path.join(__dirname, "launchd", "visibility-deadman-run.sh");
  const syntax = spawnSync("sh", ["-n", wrapper], { encoding: "utf8" });
  if (syntax.error) return console.log("     (no sh on this machine: wrapper run skipped)");
  check(syntax.status === 0, `sh -n failed: ${syntax.stderr}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vis-deadman-sh-"));
  sandboxes.push(root);
  const r = spawnSync("sh", [wrapper], {
    encoding: "utf8",
    env: {
      ...process.env,
      VISIBILITY_DEADMAN_REPO_DIR: root,
      VISIBILITY_DEADMAN_NODE_BIN: process.execPath,
      VISIBILITY_DEADMAN_TOKEN_FILE: path.join(root, "missing.token"),
    },
  });
  check(r.status === 78, `want exit 78, got ${r.status}: ${r.stderr}`);
  check(/token file not found/.test(r.stderr), "no clear message");
});

// ─── cleanup + verdict ────────────────────────────────────────────────────────────────────────
for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} case(s) FAILED`);
  process.exit(1);
}
console.log("\nall visibility-deadman self-tests passed");
