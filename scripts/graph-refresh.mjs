#!/usr/bin/env node
// graph-refresh.mjs: keep the machine's ONE code-only graph fresh (design: specs/graphify/DESIGN.md §2 items 8-12).
// Run by each machine's scheduler (never per commit, never from a git hook).
//
//   node scripts/graph-refresh.mjs [--host <graph host dir>] [--dry-run] [--force] [--min-behind 20]
//   node scripts/graph-refresh.mjs --pull <ssh-host> [--remote-host <dir>] [--host <dir>] [--dry-run]
//
// Build path (items 8-11): fetch, skip when < 20 commits behind, then inside the heavy slot:
//   GUARD_ALLOW=1 git checkout -f --detach origin/master  -> re-apply the overlay (code-only
//   .graphifyignore + "source" export condition) -> `graphify update <host>` (3600 s cap, never --force)
//   -> canary -> BUILT_AT -> prune old dated backup folders -> restart + warm the MCP server.
// Pull path (item 12): scp graph.json from another machine's host into graph.json.tmp, check the host
//   out at the SAME sha, then rename. A refused/failed update keeps the old graph and writes
//   graphify-out/REFRESH-ALERT.txt for the lead (orient shows it); success removes it.
// Never passes --force / GRAPHIFY_FORCE: a refusal means a broken build.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { findPython, probePort } from "./graph.mjs";

const require = createRequire(import.meta.url);
const core = require("./lib/graph-core.cjs");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const BUILD_TIMEOUT_MS = 3600 * 1000;
const SIDECARS = [".graphify_labels.json", ".graphify_labels.json.sig", ".graphify_root"];

export const USAGE = `graph-refresh.mjs: refresh the machine's graph host

  node scripts/graph-refresh.mjs [--host <dir>] [--dry-run] [--force] [--min-behind N]
  node scripts/graph-refresh.mjs --pull <ssh-host> [--remote-host <dir>] [--host <dir>] [--dry-run]

host defaults to GRAPHIFY_HOST, else the checkout this script sits in. --dry-run prints the plan and
changes nothing (no fetch, no checkout, no write, no kill).
`;

/** argv -> options; throws on bad usage. */
export function parseCli(argv, env = process.env) {
  const o = {
    host: env.GRAPHIFY_HOST || REPO_ROOT,
    dryRun: false,
    force: false,
    minBehind: core.REFRESH_MIN_BEHIND,
    pull: null,
    remoteHost: null,
    inSlot: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--force") o.force = true;
    else if (a === "--in-slot") o.inSlot = true;
    else if (a === "--host") o.host = need();
    else if (a === "--pull") o.pull = need();
    else if (a === "--remote-host") o.remoteHost = need();
    else if (a === "--min-behind") {
      o.minBehind = Number(need());
      if (!Number.isInteger(o.minBehind) || o.minBehind < 0)
        throw new Error("--min-behind must be a non-negative integer");
    } else throw new Error(`unknown flag ${JSON.stringify(a)}`);
  }
  o.host = path.resolve(o.host);
  return o;
}

const log = (msg) => process.stdout.write(`[graph-refresh] ${msg}\n`);

function git(host, ...args) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", ["-C", host, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
        env: { ...process.env, GUARD_ALLOW: "1" },
      }),
    };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ""), stderr: String(e.stderr || e.message) };
  }
}

function readBuiltAt(host) {
  try {
    return core.parseBuiltAt(fs.readFileSync(path.join(host, "graphify-out", "BUILT_AT"), "utf8"));
  } catch {
    return null;
  }
}

function writeAlert(host, message) {
  try {
    fs.mkdirSync(path.join(host, "graphify-out"), { recursive: true });
    fs.writeFileSync(
      path.join(host, "graphify-out", "REFRESH-ALERT.txt"),
      `${new Date().toISOString()} ${message}\n`,
    );
  } catch {
    /* the exit code still tells the scheduler */
  }
}

const clearAlert = (host) =>
  fs.rmSync(path.join(host, "graphify-out", "REFRESH-ALERT.txt"), { force: true });

/** Host sanity: a real checkout, detached (nobody's branch), no foreign local edits. Returns an error string or null. */
function checkHost(host) {
  if (!fs.existsSync(path.join(host, ".git"))) return `${host} is not a git checkout`;
  if (git(host, "symbolic-ref", "-q", "HEAD").ok)
    return `${host} is on a branch; the graph host must be detached (git checkout --detach)`;
  const st = git(host, "status", "--porcelain");
  if (!st.ok) return `git status failed in ${host}`;
  const foreign = core.foreignChanges(st.stdout);
  if (foreign.length)
    return `${host} has local changes beyond the overlay, refusing to force a checkout:\n  ${foreign.slice(0, 5).join("\n  ")}`;
  return null;
}

/** Re-apply the overlay to the host (idempotent; a no-op once both parts are on master). */
export function applyOverlay(host, { dryRun = false } = {}) {
  const changed = [];
  const ignoreFile = path.join(host, ".graphifyignore");
  const cur = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
  if (cur.replace(/\r\n/g, "\n") !== core.CODE_ONLY_IGNORE) {
    changed.push(".graphifyignore");
    if (!dryRun) fs.writeFileSync(ignoreFile, core.CODE_ONLY_IGNORE);
  }
  for (const pkg of core.SOURCE_EXPORT_PACKAGES) {
    const f = path.join(host, "packages", pkg, "package.json");
    if (!fs.existsSync(f)) continue;
    const r = core.applySourceCondition(fs.readFileSync(f, "utf8"));
    if (r.changed) {
      changed.push(`packages/${pkg}/package.json`);
      if (!dryRun) fs.writeFileSync(f, r.text);
    }
  }
  return changed;
}

/** Delete every dated backup folder (graphify-out/YYYY-MM-DD) except the newest. */
export function pruneBackups(host, { dryRun = false } = {}) {
  const out = path.join(host, "graphify-out");
  if (!fs.existsSync(out)) return [];
  const names = fs
    .readdirSync(out)
    .filter(
      (n) =>
        fs.lstatSync(path.join(out, n)).isDirectory() &&
        !fs.lstatSync(path.join(out, n)).isSymbolicLink(),
    );
  const doomed = core.backupFoldersToPrune(names, 1);
  for (const n of doomed) {
    const dir = path.join(out, n);
    // plain folders only: a link or junction here would make rmSync follow it out of graphify-out
    if (fs.realpathSync(dir) !== path.resolve(dir)) continue;
    if (!dryRun) fs.rmSync(dir, { recursive: true, force: true });
  }
  return doomed;
}

function stopServer(host) {
  const pidFile = path.join(host, "graphify-out", "serve.pid");
  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  fs.rmSync(pidFile, { force: true });
  return true;
}

/** One graph_stats call over streamable HTTP: the first call after a reload stalls 10-20 s. Best effort. */
async function warmServer(port) {
  const url = `http://${core.DEFAULT_MCP_HOST}:${port}/mcp`;
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const post = (body, extra = {}) =>
    fetch(url, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "graph-refresh", version: "1" },
    },
  });
  await init.text();
  const sid = init.headers.get("mcp-session-id");
  const extra = sid ? { "mcp-session-id": sid } : {};
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, extra).then((r) => r.text());
  await (
    await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "graph_stats", arguments: {} },
      },
      extra,
    )
  ).text();
}

async function restartServer(host, graph, { port = core.DEFAULT_MCP_PORT } = {}) {
  const had = stopServer(host);
  if (had) await new Promise((r) => setTimeout(r, 3000)); // a KeepAlive supervisor (launchd) respawns it itself
  if (!(await probePort(core.DEFAULT_MCP_HOST, port))) {
    const out = fs.openSync(path.join(host, "graphify-out", "serve.log"), "a");
    const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "graph.mjs"), "serve"], {
      cwd: host,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, GRAPHIFY_GRAPH: graph },
    });
    child.unref();
    for (let i = 0; i < 60 && !(await probePort(core.DEFAULT_MCP_HOST, port)); i++)
      await new Promise((r) => setTimeout(r, 1000));
  }
  if (!(await probePort(core.DEFAULT_MCP_HOST, port))) {
    log(
      `MCP server did not come up on ${core.DEFAULT_MCP_HOST}:${port} (is the "mcp" extra installed? see DESIGN §2 item 6); see graphify-out/serve.log`,
    );
    return false;
  }
  try {
    await warmServer(port);
    log("MCP server restarted and warmed (graph_stats)");
  } catch (e) {
    log(`MCP server is up but the warm-up call failed: ${e.message}`);
  }
  return true;
}

function nodeCount(graph) {
  try {
    const g = JSON.parse(fs.readFileSync(graph, "utf8"));
    return Array.isArray(g.nodes) ? g.nodes.length : null;
  } catch {
    return null;
  }
}

function runCanary(host, graph) {
  const r = spawnSync(process.execPath, [path.join(SCRIPT_DIR, "graph.mjs"), "canary", "--json"], {
    cwd: host,
    encoding: "utf8",
    env: { ...process.env, GRAPHIFY_GRAPH: graph, GRAPHIFY_OFF: "" },
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  try {
    const j = JSON.parse(r.stdout);
    return { label: j.label, detail: j.per };
  } catch {
    return {
      label: "blind",
      detail: `canary run failed: ${(r.stderr || "no output").trim().split("\n").pop()}`,
    };
  }
}

function writeBuiltAt(host, graph, sha, canary) {
  const rec = {
    sha,
    builtAt: new Date().toISOString(),
    nodes: nodeCount(graph),
    canary: canary.label,
    canaryDetail: canary.detail,
  };
  if (canary.label !== "pass") rec["cross-package"] = "blind";
  fs.writeFileSync(
    path.join(host, "graphify-out", "BUILT_AT"),
    `${JSON.stringify(rec, null, 2)}\n`,
  );
  return rec;
}

/** Host check + fetch + the skip verdict. Returns {code} to stop, or the facts the build needs. */
function assess(o) {
  const host = o.host;
  const graph = path.join(host, "graphify-out", "graph.json");
  const bad = checkHost(host);
  if (bad) {
    log(`REFUSED: ${bad}`);
    return { code: 2 };
  }
  if (!o.dryRun) {
    const f = git(host, "fetch", "origin");
    if (!f.ok) {
      log(`git fetch failed: ${f.stderr.trim()}`);
      return { code: 1 };
    }
  } else log("dry run: no fetch, using the refs as they are");
  const target = git(host, "rev-parse", "origin/master").stdout.trim();
  const built = readBuiltAt(host);
  const hasGraph = fs.existsSync(graph) && !!built;
  let behind = null;
  if (built) {
    const n = git(host, "rev-list", "--count", `${built.sha}..origin/master`);
    if (n.ok) behind = Number(n.stdout.trim());
  }
  const verdict = core.shouldRefresh({ behind, hasGraph, min: o.minBehind, force: o.force });
  log(
    `host ${host}: built ${built ? built.sha.slice(0, 9) : "none"}, origin/master ${target.slice(0, 9)}, ${verdict.why}`,
  );
  return verdict.go ? { host, graph, target } : { code: 0 };
}

/** The build path (runs inside the heavy slot). Returns the process exit code. */
async function refreshBuild(o) {
  const a = assess(o);
  if (a.code !== undefined) return a.code;
  const { host, graph, target } = a;
  const py = findPython();
  const steps = [
    `GUARD_ALLOW=1 git -C ${host} checkout -f --detach ${target.slice(0, 9)}`,
    "re-apply the overlay (.graphifyignore code-only list + source export condition)",
    `${py || "<graphify python NOT FOUND>"} -m graphify update ${host}   (timeout ${BUILD_TIMEOUT_MS / 1000} s, no --force)`,
    "canary: graph.mjs canary (getTierPrice RequireAddon decrementStockForSale >= 80% of grep's non-test files)",
    "write graphify-out/BUILT_AT (sha, time, nodes, canary); a failed canary also writes cross-package: blind",
    "prune every dated backup folder except the newest",
    "restart + warm the MCP server",
  ];
  if (o.dryRun) {
    log("dry run, the plan (inside `heavy-slot.mjs run --label graph-refresh`):");
    steps.forEach((s, i) => log(`  ${i + 1}. ${s}`));
    log(`  overlay would change: ${applyOverlay(host, { dryRun: true }).join(", ") || "nothing"}`);
    log(
      `  backups that would be pruned: ${pruneBackups(host, { dryRun: true }).join(", ") || "none"}`,
    );
    return 0;
  }
  if (!py) {
    writeAlert(host, "graphify python not found (set GRAPHIFY_PY)");
    log("graphify python not found (set GRAPHIFY_PY)");
    return 1;
  }
  const co = git(host, "checkout", "-f", "--detach", target);
  if (!co.ok) {
    writeAlert(host, `checkout failed: ${co.stderr.trim()}`);
    log(`checkout failed: ${co.stderr.trim()}`);
    return 1;
  }
  log(`overlay changed: ${applyOverlay(host).join(", ") || "nothing"}`);
  const up = spawnSync(py, ["-I", "-X", "utf8", "-m", "graphify", "update", host], {
    cwd: host,
    stdio: "inherit",
    timeout: BUILD_TIMEOUT_MS,
    env: { ...process.env, GRAPHIFY_FORCE: "" },
  });
  if (up.status !== 0) {
    const why =
      up.error?.code === "ETIMEDOUT"
        ? "update timed out"
        : `update exited ${up.status} (a refusal means a broken build; the old graph is kept)`;
    writeAlert(host, why);
    log(`${why}; alert written`);
    return 1;
  }
  const canary = runCanary(host, graph);
  const rec = writeBuiltAt(host, graph, target, canary);
  log(
    `BUILT_AT: ${rec.sha.slice(0, 9)}, ${rec.nodes ?? "?"} nodes, canary ${rec.canary}${rec.canary !== "pass" ? " (cross-package: blind, keep the @routeflow/* grep rule)" : ""}`,
  );
  log(`pruned backups: ${pruneBackups(host).join(", ") || "none"}`);
  clearAlert(host);
  await restartServer(host, graph);
  return 0;
}

function scp(args) {
  return spawnSync("scp", ["-q", "-o", "BatchMode=yes", ...args], {
    encoding: "utf8",
    timeout: 600_000,
  });
}

/** --pull <ssh-host>: copy another machine's graph, then match its sha. */
async function refreshPull(o) {
  const host = o.host;
  const out = path.join(host, "graphify-out");
  const remote = o.remoteHost || "code/rf-mobile-release"; // relative to the remote user's home
  const spec = (f) => `${o.pull}:${remote}/graphify-out/${f}`;
  const bad = checkHost(host);
  if (bad) {
    log(`REFUSED: ${bad}`);
    return 2;
  }
  const tmpBuilt = path.join(os.tmpdir(), `graph-built-at-${process.pid}`);
  if (o.dryRun) {
    log(
      `dry run: would scp ${spec("BUILT_AT")}, then ${spec("graph.json")} -> ${path.join(out, "graph.json.tmp")}, check the host out at that sha, re-apply the overlay, rename, restart the server`,
    );
    return 0;
  }
  fs.mkdirSync(out, { recursive: true });
  let r = scp([spec("BUILT_AT"), tmpBuilt]);
  if (r.status !== 0) {
    log(`scp BUILT_AT failed: ${(r.stderr || "").trim()}`);
    return 1;
  }
  const remoteBuilt = core.parseBuiltAt(fs.readFileSync(tmpBuilt, "utf8"));
  fs.rmSync(tmpBuilt, { force: true });
  if (!remoteBuilt) {
    log("remote BUILT_AT is unreadable");
    return 1;
  }
  const local = readBuiltAt(host);
  if (local && local.sha === remoteBuilt.sha && fs.existsSync(path.join(out, "graph.json"))) {
    log(`already at ${remoteBuilt.sha.slice(0, 9)}`);
    return 0;
  }
  const tmp = path.join(out, "graph.json.tmp");
  r = scp([spec("graph.json"), tmp]);
  if (r.status !== 0) {
    fs.rmSync(tmp, { force: true });
    log(`scp graph.json failed: ${(r.stderr || "").trim()}`);
    return 1;
  }
  for (const f of SIDECARS) scp([spec(f), path.join(out, `${f}.tmp`)]); // best effort
  git(host, "fetch", "origin");
  const co = git(host, "checkout", "-f", "--detach", remoteBuilt.sha);
  if (!co.ok) {
    fs.rmSync(tmp, { force: true });
    writeAlert(host, `pull: cannot check out ${remoteBuilt.sha}: ${co.stderr.trim()}`);
    log(
      `checkout ${remoteBuilt.sha.slice(0, 9)} failed: ${co.stderr.trim()}; graph left as it was`,
    );
    return 1;
  }
  applyOverlay(host);
  fs.renameSync(tmp, path.join(out, "graph.json"));
  for (const f of SIDECARS) {
    const t = path.join(out, `${f}.tmp`);
    if (fs.existsSync(t)) fs.renameSync(t, path.join(out, f));
  }
  fs.writeFileSync(
    path.join(out, "BUILT_AT"),
    `${JSON.stringify({ ...remoteBuilt, pulledFrom: o.pull, pulledAt: new Date().toISOString() }, null, 2)}\n`,
  );
  log(
    `pulled ${remoteBuilt.sha.slice(0, 9)} from ${o.pull} (canary ${remoteBuilt.canary || "unknown"})`,
  );
  log(`pruned backups: ${pruneBackups(host).join(", ") || "none"}`);
  clearAlert(host);
  await restartServer(host, path.join(out, "graph.json"));
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try {
    o = parseCli(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (o.pull) return refreshPull(o);
  // the build runs inside the machine-wide heavy slot (nested use under a scheduler's wrapper is a
  // no-op there); the skip check runs first so a no-op refresh never queues
  if (!o.inSlot && !o.dryRun) {
    const pre = assess(o);
    if (pre.code !== undefined) return pre.code;
    const r = spawnSync(
      process.execPath,
      [
        path.join(SCRIPT_DIR, "heavy-slot.mjs"),
        "run",
        "--label",
        "graph-refresh",
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        ...argv,
        "--in-slot",
      ],
      { stdio: "inherit" },
    );
    return r.status ?? 1;
  }
  return refreshBuild(o);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`graph-refresh.mjs: ${e.stack || e}\n`);
      process.exit(1);
    },
  );
}
