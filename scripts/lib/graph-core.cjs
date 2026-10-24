"use strict";
// Pure helpers behind scripts/graph.mjs and scripts/graph-refresh.mjs (no I/O of their own, so
// apps/api/src/common/graph-core.spec.ts can pin them). Design: specs/graphify/DESIGN.md §2-§3.

const path = require("node:path");

/** Roots `git grep` and the reconcile look at (the graph also holds .claude/docs nodes; ignored). */
const SCOPE_DIRS = ["apps", "packages"];
const DEFAULT_CAP = 40;
const DEFAULT_DEPTH = 2;
const RADIUS_RELATIONS = ["calls", "indirect_call", "references"];
const DEFAULT_MCP_HOST = "127.0.0.1";
const DEFAULT_MCP_PORT = 8765;
const CANARY_SYMBOLS = ["getTierPrice", "RequireAddon", "decrementStockForSale"];
const CANARY_THRESHOLD = 0.8;
const REFRESH_MIN_BEHIND = 20;

/** The code-only `.graphifyignore` (kept in sync with the repo file by graph-core.spec.ts). */
const CODE_ONLY_IGNORE = `# graphify (shared code graph): map the SOURCE only, not docs, notes or copies
.claude/
docs/
**/*.md
local-assets/
graphify-out/
node_modules/
**/dist/
**/.next/
apps/mobile/ios/
apps/mobile/android/
`;

/** Workspace packages whose "." export gets a leading "source" condition (graphify ranks it first). */
const SOURCE_EXPORT_PACKAGES = ["pricing", "scanning", "returns"];

const toPosix = (p) => String(p).replace(/\\/g, "/");

/** GRAPHIFY_OFF=1 (also true/yes/on) turns every graph.mjs command into a no-op. */
function isGraphOff(env) {
  const v = String((env && env.GRAPHIFY_OFF) || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** "file.ts::Symbol" -> {raw, file, name}; a bare name or a node id -> {raw, name}. */
function parseSymbolSpec(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) throw new Error("empty symbol");
  const i = text.lastIndexOf("::");
  if (i === -1) return { raw: text, name: text };
  const file = toPosix(text.slice(0, i)).replace(/^\.\//, "");
  const name = text.slice(i + 2).trim();
  if (!file || !name)
    throw new Error(`bad symbol spec ${JSON.stringify(text)} (want file.ts::Symbol)`);
  return { raw: text, file, name };
}

/**
 * argv (after node + script) -> {cmd, symbols, passthrough, flags}.
 * radius/canary read --depth N, --cap N, --json; explain|affected|path pass their args through.
 */
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") return { cmd: "help" };
  const flags = { depth: DEFAULT_DEPTH, cap: DEFAULT_CAP, json: false };
  if (["explain", "affected", "path"].includes(cmd)) return { cmd, passthrough: rest, flags };
  if (!["radius", "status", "serve", "canary"].includes(cmd)) {
    throw new Error(`unknown command ${JSON.stringify(cmd)}`);
  }
  const symbols = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") flags.json = true;
    else if ((a === "--depth" || a === "--cap" || a === "--port") && rest[i + 1] !== undefined) {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${a} must be a non-negative integer`);
      flags[a.slice(2)] = n;
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${JSON.stringify(a)}`);
    else symbols.push(parseSymbolSpec(a));
  }
  if (cmd === "radius" && symbols.length === 0) throw new Error("radius needs at least one symbol");
  return { cmd, symbols, flags };
}

/**
 * Where the graph lives. First hit wins:
 * GRAPHIFY_GRAPH, $GRAPHIFY_HOST, the host the script itself sits in, the cwd's host, then the
 * conventional graph-host checkouts (~/code/rf-mobile-release on a Mac, C:/ClaudeCode/... on the PC).
 */
function resolveGraphPath({ env = {}, scriptDir, cwd, home, exists }) {
  const tried = [];
  const add = (p, source) => tried.push({ graph: toPosix(p), source });
  if (env.GRAPHIFY_GRAPH) add(env.GRAPHIFY_GRAPH, "GRAPHIFY_GRAPH");
  if (env.GRAPHIFY_HOST)
    add(path.posix.join(toPosix(env.GRAPHIFY_HOST), "graphify-out/graph.json"), "GRAPHIFY_HOST");
  if (scriptDir)
    add(path.posix.join(toPosix(scriptDir), "../graphify-out/graph.json"), "script-host");
  if (cwd) add(path.posix.join(toPosix(cwd), "graphify-out/graph.json"), "cwd");
  if (home)
    add(
      path.posix.join(toPosix(home), "code/rf-mobile-release/graphify-out/graph.json"),
      "default-mac",
    );
  add("C:/ClaudeCode/rf-mobile-release/graphify-out/graph.json", "default-pc");
  for (const t of tried) {
    const graph = path.posix.normalize(t.graph);
    if (exists(graph))
      return { graph, host: path.posix.dirname(path.posix.dirname(graph)), source: t.source };
    // an explicit override that does not exist is an error, not a reason to silently use another graph
    if (t.source === "GRAPHIFY_GRAPH")
      return {
        graph: null,
        tried: tried.map((x) => path.posix.normalize(x.graph)),
        explicit: graph,
      };
  }
  return { graph: null, tried: tried.map((x) => path.posix.normalize(x.graph)) };
}

/** Ordered interpreter candidates for graphify's own Python (first existing + importable wins). */
function pythonCandidates({ env = {}, home = "", platform = process.platform }) {
  const out = [];
  if (env.GRAPHIFY_PY) out.push(toPosix(env.GRAPHIFY_PY));
  const win = platform === "win32";
  const exe = win ? "Scripts/python.exe" : "bin/python";
  const venv = (base) => `${toPosix(base)}/graphifyy/${exe}`;
  if (env.PIPX_LOCAL_VENVS) out.push(venv(env.PIPX_LOCAL_VENVS));
  if (env.PIPX_HOME) out.push(venv(`${env.PIPX_HOME}/venvs`));
  if (win) {
    if (env.LOCALAPPDATA) out.push(venv(`${env.LOCALAPPDATA}/pipx/pipx/venvs`));
    if (env.USERPROFILE) out.push(venv(`${env.USERPROFILE}/pipx/venvs`));
    if (env.APPDATA) out.push(venv(`${env.APPDATA}/uv/tools`));
    if (env.LOCALAPPDATA) out.push(venv(`${env.LOCALAPPDATA}/uv/tools`));
  } else if (home) {
    out.push(venv(`${home}/.local/pipx/venvs`));
    out.push(venv(`${home}/.local/share/pipx/venvs`));
    out.push(venv(`${home}/.local/share/uv/tools`));
    out.push(venv(`${home}/Library/Application Support/uv/tools`));
  }
  return [...new Set(out)];
}

/** `#!/path/to/python` line of the `graphify` launcher (POSIX installs) -> the path, else null. */
function pythonFromShebang(firstLine) {
  const m = /^#!\s*(\S+)/.exec(String(firstLine || ""));
  return m && /python/i.test(m[1]) ? m[1] : null;
}

/** BUILT_AT is JSON {sha, builtAt, nodes, canary}; tolerate a bare "sha ..." text line. */
function parseBuiltAt(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    if (j && typeof j === "object" && typeof j.sha === "string") return j;
  } catch {
    /* fall through to the text form */
  }
  const m = /^([0-9a-f]{7,40})\b/i.exec(s);
  return m ? { sha: m[1] } : null;
}

const short = (sha) => (sha ? String(sha).slice(0, 9) : "unknown");

/** `graph@<sha> N behind` (the header on every output). */
function formatHeader({ sha, behind, off }) {
  if (off) return "graph off";
  if (!sha) return "graph@missing";
  return `graph@${short(sha)} ${behind == null ? "?" : behind} behind`;
}

const SPEC_RE =
  /(?:\.|-)(?:spec|test)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/|(?:^|\/)e2e\/|\.self-test\.[cm]?js$/;
const isSpecFile = (p) => SPEC_RE.test(toPosix(p));
const inScope = (p) => SCOPE_DIRS.some((d) => toPosix(p).startsWith(`${d}/`));

/** `git grep -l` stdout -> sorted unique repo-relative posix paths (in scope only). */
function parseGrepOutput(stdout) {
  const set = new Set();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const p = toPosix(line.trim());
    if (p && inScope(p)) set.add(p);
  }
  return [...set].sort();
}

/**
 * The four lists. graphHits: [{file, rel, depth}] (file already repo-relative); grepFiles: string[];
 * defFiles: the symbol's own definition file(s), dropped from every list.
 * both / graphOnly / grepOnly never contain a spec file; those all land in `specs`.
 */
function reconcile({ graphHits = [], grepFiles = [], defFiles = [] }) {
  const skip = new Set(defFiles.map(toPosix));
  const graph = new Map(); // file -> {file, rel, depth} (shallowest hit wins)
  for (const h of graphHits) {
    const file = toPosix(h.file || "");
    if (!file || skip.has(file) || !inScope(file)) continue;
    const prev = graph.get(file);
    if (!prev || h.depth < prev.depth) graph.set(file, { file, rel: h.rel, depth: h.depth });
  }
  const grep = new Set(grepFiles.map(toPosix).filter((f) => !skip.has(f) && inScope(f)));
  const both = [];
  const grepOnly = [];
  const graphOnly = [];
  const specs = new Set();
  for (const f of grep) {
    if (isSpecFile(f)) specs.add(f);
    else if (graph.has(f)) both.push(f);
    else grepOnly.push(f);
  }
  for (const [f, hit] of graph) {
    if (isSpecFile(f)) specs.add(f);
    else if (!grep.has(f)) graphOnly.push(hit);
  }
  both.sort();
  grepOnly.sort();
  graphOnly.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  return { both, grepOnly, graphOnly, specs: [...specs].sort() };
}

/** First `cap` items plus how many were left out. */
function capList(items, cap = DEFAULT_CAP) {
  return { shown: items.slice(0, cap), more: Math.max(0, items.length - cap) };
}

/** One list as text lines: `label (n):` then indented items, `+N more` when capped. */
function renderList(label, items, { cap = DEFAULT_CAP, fmt = (x) => x, note = "" } = {}) {
  const { shown, more } = capList(items, cap);
  const head = `${label} (${items.length})${note ? ` ${note}` : ""}${items.length ? ":" : ""}`;
  const lines = [head, ...shown.map((x) => `  ${fmt(x)}`)];
  if (more) lines.push(`  +${more} more`);
  return lines;
}

/**
 * Canary: for every symbol the graph must find >= threshold of grep's non-test files.
 * results: [{symbol, both, grepOnly}] (counts or arrays).
 */
function canaryVerdict(results, threshold = CANARY_THRESHOLD) {
  const n = (x) => (Array.isArray(x) ? x.length : Number(x) || 0);
  const per = results.map((r) => {
    const found = n(r.both);
    const total = found + n(r.grepOnly);
    return { symbol: r.symbol, found, total, recall: total ? found / total : null };
  });
  const pass = per.length > 0 && per.every((p) => p.recall !== null && p.recall >= threshold);
  return { pass, threshold, per };
}

const canaryLabel = (v) => (v.pass ? "pass" : "blind");

/** graphify-mcp argv + env for `graph.mjs serve` (the exact command of DESIGN §2 item 6). */
function buildServeCommand({ graph, host = DEFAULT_MCP_HOST, port = DEFAULT_MCP_PORT }) {
  return {
    args: [
      "-I",
      "-X",
      "utf8",
      "-m",
      "graphify.serve",
      "--transport",
      "http",
      "--host",
      host,
      "--port",
      String(port),
      "--session-timeout",
      "0",
      graph,
    ],
    env: { GRAPHIFY_MAX_CONTEXTS: "1" },
  };
}

/** One query-log.jsonl record. */
function buildLogRecord({ cmd, symbols = [], ms, bytes, sha, behind, grepOnly, now = new Date() }) {
  return {
    ts: now.toISOString(),
    cmd,
    symbols: symbols.map((s) => (typeof s === "string" ? s : s.raw)),
    ms,
    bytes,
    sha: sha ? short(sha) : null,
    behind: behind == null ? null : behind,
    grepOnly: grepOnly == null ? null : grepOnly,
  };
}

// ---- refresh helpers -------------------------------------------------------------------------

/** Refresh only when the graph is missing or at least `min` commits behind. */
function shouldRefresh({ behind, hasGraph, min = REFRESH_MIN_BEHIND, force = false }) {
  if (force || !hasGraph || behind == null)
    return { go: true, why: !hasGraph ? "no graph" : "forced or unknown distance" };
  return behind >= min
    ? { go: true, why: `${behind} behind (>= ${min})` }
    : { go: false, why: `${behind} behind (< ${min})` };
}

/** Dated backup folders (graphify copies the old graph into graphify-out/YYYY-MM-DD/): keep newest. */
function backupFoldersToPrune(names, keep = 1) {
  const dated = names.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  return keep > 0 ? dated.slice(0, Math.max(0, dated.length - keep)) : dated;
}

/** Put "source" first in exports["."] (idempotent; text insertion so nothing else is reformatted). */
function applySourceCondition(pkgText) {
  const dot = JSON.parse(pkgText).exports?.["."];
  if (!dot || typeof dot !== "object") return { text: pkgText, changed: false };
  if (Object.keys(dot)[0] === "source" && dot.source === "./src/index.ts")
    return { text: pkgText, changed: false };
  const m = /("exports"\s*:\s*\{\s*"\."\s*:\s*\{)([ \t]*\r?\n)([ \t]*)/.exec(pkgText);
  if (!m || "source" in dot) {
    // unusual layout, or a misplaced "source": rewrite the object (reformats the file, so rare on purpose)
    const pkg = JSON.parse(pkgText);
    const rest = Object.entries(dot).filter(([k]) => k !== "source");
    pkg.exports["."] = { source: "./src/index.ts", ...Object.fromEntries(rest) };
    const eol = pkgText.includes("\r\n") ? "\r\n" : "\n";
    return {
      text: JSON.stringify(pkg, null, 2).replace(/\n/g, eol) + (/\n$/.test(pkgText) ? eol : ""),
      changed: true,
    };
  }
  const eol = m[2].includes("\r") ? "\r\n" : "\n";
  const at = m.index + m[0].length;
  return {
    text: pkgText.slice(0, at) + '"source": "./src/index.ts",' + eol + m[3] + pkgText.slice(at),
    changed: true,
  };
}

/** Porcelain lines that are NOT the overlay (a host with any of these must not be force-checked-out). */
function foreignChanges(porcelain) {
  const overlay = new Set([
    ".graphifyignore",
    ...SOURCE_EXPORT_PACKAGES.map((p) => `packages/${p}/package.json`),
  ]);
  return String(porcelain || "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .filter((l) => {
      const file = toPosix(l.slice(3).trim().replace(/^"|"$/g, ""));
      return !overlay.has(file) && !file.startsWith("graphify-out/");
    });
}

module.exports = {
  SCOPE_DIRS,
  DEFAULT_CAP,
  DEFAULT_DEPTH,
  RADIUS_RELATIONS,
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  CANARY_SYMBOLS,
  CANARY_THRESHOLD,
  REFRESH_MIN_BEHIND,
  CODE_ONLY_IGNORE,
  SOURCE_EXPORT_PACKAGES,
  toPosix,
  isGraphOff,
  parseSymbolSpec,
  parseArgs,
  resolveGraphPath,
  pythonCandidates,
  pythonFromShebang,
  parseBuiltAt,
  formatHeader,
  isSpecFile,
  inScope,
  parseGrepOutput,
  reconcile,
  capList,
  renderList,
  canaryVerdict,
  canaryLabel,
  buildServeCommand,
  buildLogRecord,
  shouldRefresh,
  backupFoldersToPrune,
  applySourceCondition,
  foreignChanges,
};
