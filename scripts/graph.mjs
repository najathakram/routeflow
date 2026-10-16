#!/usr/bin/env node
// graph.mjs: the fleet's graph-first lookups (design: specs/graphify/DESIGN.md §2 items 4-7, §3 item 4).
//
//   node scripts/graph.mjs radius <Sym...> [--depth N] [--cap N] [--json]   blast radius: graph + git grep, four lists
//   node scripts/graph.mjs explain|affected|path <args...>                   graphify CLI with --graph added
//   node scripts/graph.mjs status                                            graph sha, commits behind, MCP up/down, canary
//   node scripts/graph.mjs canary [--json]                                   the refresh canary (never run by a lane)
//   node scripts/graph.mjs serve [--port N]                                  graphify-mcp over http on 127.0.0.1:8765
//
// <Sym> is a name, a node id, or file.ts::Symbol. Every output starts with `graph@<sha> N behind`.
// An empty graph answer is UNKNOWN, never "none": the grep-only list is the one to read first.
// Never builds a graph (graph-refresh.mjs does, on the host, on a schedule).
//
// Env: GRAPHIFY_GRAPH (graph.json path), GRAPHIFY_HOST, GRAPHIFY_PY (graphify's python), GRAPHIFY_OFF=1
// (print "graph off", exit 0: the A/B control arm and the rollback switch).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require("./lib/graph-core.cjs");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(SCRIPT_DIR, "lib", "graph-radius.py");
const GRAPH_TIMEOUT_MS = 300_000;

export const USAGE = `graph.mjs: graph-first lookups (graph + git grep)

  node scripts/graph.mjs radius <Sym...> [--depth N] [--cap N] [--json]
  node scripts/graph.mjs explain|affected|path <graphify args>
  node scripts/graph.mjs status | canary | serve [--port N]

<Sym> = name | node id | file.ts::Symbol.  Env: GRAPHIFY_GRAPH GRAPHIFY_HOST GRAPHIFY_PY GRAPHIFY_OFF=1
`;

// ---- small process helpers ------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      ...opts,
    });
    return { ok: true, stdout, status: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || ""),
      stderr: String(e.stderr || ""),
      status: e.status ?? -1,
    };
  }
}

const git = (cwd, ...args) => run("git", ["-C", cwd, ...args]);

/** graphify's own interpreter: GRAPHIFY_PY, the pipx / uv venv, or the `graphify` launcher's shebang. */
export function findPython(env = process.env) {
  const cands = core.pythonCandidates({ env, home: os.homedir(), platform: process.platform });
  if (process.platform !== "win32") {
    const which = run("which", ["graphify"]);
    if (which.ok) {
      try {
        const first = fs.readFileSync(which.stdout.trim(), "utf8").split("\n", 1)[0];
        const py = core.pythonFromShebang(first);
        if (py) cands.push(py);
      } catch {
        /* binary launcher: fall through */
      }
    }
  }
  for (const py of cands) {
    if (!fs.existsSync(py)) continue;
    if (run(py, ["-I", "-c", "import graphify.affected"], { timeout: 30_000 }).ok) return py;
  }
  return null;
}

export function probePort(host, port, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (up) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

// ---- graph context ---------------------------------------------------------------------------

export function readContext({ env = process.env, cwd = process.cwd() } = {}) {
  const found = core.resolveGraphPath({
    env,
    scriptDir: SCRIPT_DIR,
    cwd,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
  });
  if (!found.graph) return { graph: null, found };
  const dir = path.posix.dirname(found.graph);
  let builtAt = null;
  try {
    builtAt = core.parseBuiltAt(fs.readFileSync(path.join(dir, "BUILT_AT"), "utf8"));
  } catch {
    /* no BUILT_AT yet */
  }
  const host = found.host;
  const sha = builtAt?.sha || git(host, "rev-parse", "HEAD").stdout.trim() || null;
  let behind = null;
  if (sha) {
    const n = git(host, "rev-list", "--count", `${sha}..origin/master`);
    if (n.ok && /^\d+$/.test(n.stdout.trim())) behind = Number(n.stdout.trim());
  }
  return { graph: found.graph, host, dir, source: found.source, builtAt, sha, behind, found };
}

// ---- radius ----------------------------------------------------------------------------------

function gitGrepFiles(cwd, name) {
  const r = run("git", ["-C", cwd, "grep", "-lwF", "-e", name, "--", ...core.SCOPE_DIRS]);
  if (!r.ok && r.status !== 1)
    return { files: [], error: (r.stderr || "git grep failed").trim().split("\n")[0] };
  return { files: core.parseGrepOutput(r.stdout) };
}

/** One python load for all symbols, then git grep per symbol; returns structured results. */
export function computeRadius({ graph, symbols, depth, cwd, py }) {
  let py_out = null;
  let note = null;
  if (!graph) note = "graph missing";
  else if (!py) note = "graphify python not found (set GRAPHIFY_PY)";
  else {
    const r = spawnSync(py, ["-I", "-X", "utf8", HELPER], {
      input: JSON.stringify({ graph, symbols, relations: core.RADIUS_RELATIONS, depth }),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: GRAPH_TIMEOUT_MS,
    });
    if (r.status === 0) py_out = JSON.parse(r.stdout);
    else
      note = `graph load failed: ${(r.stderr || r.error?.message || "unknown").trim().split("\n").pop()}`;
  }
  const results = symbols.map((spec, i) => {
    const g = py_out?.results[i];
    const grep = gitGrepFiles(cwd, spec.name);
    const base = { symbol: spec.raw, status: g?.status || "nograph", grepError: grep.error };
    const defFiles = g?.defFile ? [g.defFile] : [];
    if (g?.status === "ok") {
      const lists = core.reconcile({
        graphHits: g.hits.map((h) => ({ file: h.file, rel: h.rel, depth: h.depth })),
        grepFiles: grep.files,
        defFiles,
      });
      return {
        ...base,
        def: `${g.defFile}:${g.defLoc}`,
        label: g.label,
        hitCount: g.hits.length,
        ...lists,
      };
    }
    // not in the graph (or no graph): everything grep found is unclassified, i.e. grep-only
    const lists = core.reconcile({ graphHits: [], grepFiles: grep.files, defFiles });
    return {
      ...base,
      candidates: g?.candidates || [],
      candidateCount: g?.candidateCount || 0,
      ...lists,
    };
  });
  return { note, nodes: py_out?.nodes ?? null, results };
}

function renderRadius(radius, cap) {
  const out = [];
  if (radius.note)
    out.push(`graph: ${radius.note}; showing grep only, treat every file as grep-only`);
  for (const r of radius.results) {
    const head =
      r.status === "ok"
        ? `## ${r.symbol}  ${r.def}  [${r.hitCount} graph hits]`
        : r.status === "ambiguous"
          ? `## ${r.symbol}  AMBIGUOUS in graph (${r.candidateCount} candidates): re-run with file.ts::Symbol or a node id`
          : r.status === "notfound"
            ? `## ${r.symbol}  NOT IN GRAPH: UNKNOWN, not "none"; grep is the only answer`
            : `## ${r.symbol}  (grep only)`;
    out.push(head);
    if (r.grepError) out.push(`grep: ${r.grepError}`);
    if (r.status === "ambiguous") {
      for (const c of r.candidates) {
        const where = c.file ? `${c.file}${c.loc ? `:${c.loc}` : ""}` : "";
        out.push(`  ${[c.id, c.label !== c.id ? c.label : "", where].filter(Boolean).join("  ")}`);
      }
      if (r.candidateCount > r.candidates.length)
        out.push(`  +${r.candidateCount - r.candidates.length} more`);
    }
    out.push(...core.renderList("both", r.both, { cap }));
    out.push(...core.renderList("grep-only", r.grepOnly, { cap, note: "READ FIRST" }));
    if (r.status === "ok") {
      out.push(
        ...core.renderList("graph-only", r.graphOnly, {
          cap,
          note: "transitive",
          fmt: (h) => `${h.file} [${h.rel} d${h.depth}]`,
        }),
      );
    }
    out.push(...core.renderList("specs", r.specs, { cap }));
  }
  return out;
}

function appendLog(ctx, record, env = process.env) {
  if (!ctx.dir) return;
  try {
    const file = env.GRAPHIFY_QUERY_LOG || path.join(ctx.dir, "query-log.jsonl");
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    /* read-only host or no disk: telemetry must never fail a lookup */
  }
}

async function cmdRadius(parsed, io) {
  const t0 = Date.now();
  const ctx = readContext({ env: io.env, cwd: io.cwd });
  const py = ctx.graph ? findPython(io.env) : null;
  const radius = computeRadius({
    graph: ctx.graph,
    symbols: parsed.symbols,
    depth: parsed.flags.depth,
    cwd: io.cwd,
    py,
  });
  const header = core.formatHeader({ sha: ctx.sha, behind: ctx.behind });
  const text = parsed.flags.json
    ? JSON.stringify({ header, graph: ctx.graph, note: radius.note, results: radius.results })
    : [header, ...renderRadius(radius, parsed.flags.cap)].join("\n");
  io.out(text);
  appendLog(
    ctx,
    core.buildLogRecord({
      cmd: "radius",
      symbols: parsed.symbols,
      ms: Date.now() - t0,
      bytes: Buffer.byteLength(text),
      sha: ctx.sha,
      behind: ctx.behind,
      grepOnly: radius.results.reduce((n, r) => n + r.grepOnly.length, 0),
    }),
  );
  return 0;
}

async function cmdCanary(parsed, io) {
  const ctx = readContext({ env: io.env, cwd: io.cwd });
  const py = ctx.graph ? findPython(io.env) : null;
  const symbols = core.CANARY_SYMBOLS.map((s) => core.parseSymbolSpec(s));
  const radius = computeRadius({
    graph: ctx.graph,
    symbols,
    depth: parsed.flags.depth,
    cwd: io.cwd,
    py,
  });
  const verdict = core.canaryVerdict(
    radius.results.map((r) => ({ symbol: r.symbol, both: r.both, grepOnly: r.grepOnly })),
    core.CANARY_THRESHOLD,
  );
  const lines = verdict.per.map(
    (p) =>
      `${p.symbol}: graph found ${p.found}/${p.total} of grep's non-test files${p.recall === null ? "" : ` (${Math.round(p.recall * 100)}%)`}`,
  );
  io.out(
    parsed.flags.json
      ? JSON.stringify({ ...verdict, label: core.canaryLabel(verdict), note: radius.note })
      : [
          core.formatHeader({ sha: ctx.sha, behind: ctx.behind }),
          ...lines,
          `canary: ${core.canaryLabel(verdict)} (>= ${verdict.threshold * 100}% each)`,
        ].join("\n"),
  );
  return verdict.pass ? 0 : 1;
}

async function cmdPassthrough(parsed, io) {
  const ctx = readContext({ env: io.env, cwd: io.cwd });
  if (!ctx.graph) {
    io.err(`graph: MISSING (tried ${ctx.found.tried.join(", ")}). Use grep + the code map.`);
    return 2;
  }
  const py = findPython(io.env);
  if (!py) {
    io.err("graph: graphify python not found (set GRAPHIFY_PY, or `pipx install graphifyy`).");
    return 2;
  }
  const args = [...parsed.passthrough];
  if (
    parsed.cmd === "affected" &&
    !args.some((a) => a === "--relation" || a.startsWith("--relation="))
  ) {
    for (const r of core.RADIUS_RELATIONS) args.push("--relation", r);
    if (!args.some((a) => a === "--depth" || a.startsWith("--depth=")))
      args.push("--depth", String(core.DEFAULT_DEPTH));
  }
  if (!args.some((a) => a === "--graph" || a.startsWith("--graph=")))
    args.push("--graph", ctx.graph);
  const t0 = Date.now();
  const r = spawnSync(py, ["-I", "-X", "utf8", "-m", "graphify", parsed.cmd, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: GRAPH_TIMEOUT_MS,
  });
  const text = [
    core.formatHeader({ sha: ctx.sha, behind: ctx.behind }),
    (r.stdout || "").trimEnd(),
    (r.stderr || "").trimEnd(),
  ]
    .filter(Boolean)
    .join("\n");
  io.out(text);
  appendLog(
    ctx,
    core.buildLogRecord({
      cmd: parsed.cmd,
      symbols: [parsed.passthrough[0] || ""],
      ms: Date.now() - t0,
      bytes: Buffer.byteLength(text),
      sha: ctx.sha,
      behind: ctx.behind,
    }),
  );
  return r.status ?? 1;
}

async function cmdStatus(_parsed, io) {
  const ctx = readContext({ env: io.env, cwd: io.cwd });
  const up = await probePort(core.DEFAULT_MCP_HOST, core.DEFAULT_MCP_PORT);
  if (!ctx.graph) {
    io.out(
      `graph: MISSING (tried ${ctx.found.tried.join(", ")}); use grep and the code map, tell the lead\nMCP: ${up ? "up" : "down"}`,
    );
    return 0;
  }
  const st = fs.statSync(ctx.graph);
  const b = ctx.builtAt;
  const lines = [
    core.formatHeader({ sha: ctx.sha, behind: ctx.behind }),
    `graph: ${ctx.graph} (${(st.size / 1e6).toFixed(1)} MB, file ${st.mtime.toISOString()})`,
    b
      ? `built: ${b.builtAt || "?"}, ${b.nodes ?? "?"} nodes${b.canary ? `, canary ${b.canary}` : ""}`
      : "built: no BUILT_AT (run graph-refresh.mjs)",
    `MCP: ${up ? "up" : "down"} (${core.DEFAULT_MCP_HOST}:${core.DEFAULT_MCP_PORT})`,
    `canary: ${b?.canary || "unknown"}${b?.canary === "blind" ? " (keep the @routeflow/* grep rule)" : ""}`,
  ];
  if (ctx.behind != null && ctx.behind > 200)
    lines.push("WARNING: graph is more than 200 commits behind");
  io.out(lines.join("\n"));
  return 0;
}

async function cmdServe(parsed, io) {
  const ctx = readContext({ env: io.env, cwd: io.cwd });
  if (!ctx.graph) {
    io.err(`graph: MISSING (tried ${ctx.found.tried.join(", ")}); nothing to serve.`);
    return 2;
  }
  const port = parsed.flags.port ?? core.DEFAULT_MCP_PORT;
  if (await probePort(core.DEFAULT_MCP_HOST, port)) {
    io.out(`already serving on ${core.DEFAULT_MCP_HOST}:${port}`);
    return 0;
  }
  const py = findPython(io.env);
  if (!py) {
    io.err("graph: graphify python not found (set GRAPHIFY_PY).");
    return 2;
  }
  const cmd = core.buildServeCommand({ graph: ctx.graph, port });
  const pidFile = path.join(ctx.dir, "serve.pid");
  const child = spawn(py, cmd.args, { stdio: "inherit", env: { ...io.env, ...cmd.env } });
  try {
    fs.writeFileSync(pidFile, String(child.pid));
  } catch {
    /* pid file is only how graph-refresh finds the server to restart */
  }
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return await new Promise((resolve) => {
    child.on("exit", (code) => {
      try {
        fs.rmSync(pidFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve(code ?? 1);
    });
  });
}

/** Runs one CLI invocation; returns the exit code. */
export async function main(argv = process.argv.slice(2), io = {}) {
  io = {
    env: process.env,
    cwd: process.cwd(),
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    ...io,
  };
  if (core.isGraphOff(io.env)) {
    io.out("graph off");
    return 0;
  }
  let parsed;
  try {
    parsed = core.parseArgs(argv);
  } catch (e) {
    io.err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  switch (parsed.cmd) {
    case "help":
      io.out(USAGE);
      return 0;
    case "radius":
      return cmdRadius(parsed, io);
    case "canary":
      return cmdCanary(parsed, io);
    case "status":
      return cmdStatus(parsed, io);
    case "serve":
      return cmdServe(parsed, io);
    default:
      return cmdPassthrough(parsed, io);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`graph.mjs: ${e.stack || e}\n`);
      process.exit(1);
    },
  );
}
