// Paths, machine/lane identity and the default fleet config for the ops monitor.
// The data never lives in this repo: events and views go to a tool-owned clone of the
// private routeflow-specs repo (default ~/.routeflow/ops/routeflow-specs), so the CLI and
// the monitor never touch a human's working checkout.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the routeflow checkout this tool runs from (…/tools/ops-monitor/lib → repo root). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const TOOL_ROOT = resolve(REPO_ROOT, "tools", "ops-monitor");

export const DEFAULT_SPECS_REMOTE = "https://github.com/najathakram/routeflow-specs.git";
export const GITHUB_REPO = "najathakram/routeflow";

export function opsHome(env = process.env) {
  return env.RF_OPS_HOME ? resolve(env.RF_OPS_HOME) : join(homedir(), ".routeflow", "ops");
}
export function specsDir(env = process.env) {
  return env.RF_SPECS_DIR ? resolve(env.RF_SPECS_DIR) : join(opsHome(env), "routeflow-specs");
}
export function specsRemote(env = process.env) {
  return env.RF_SPECS_REMOTE || DEFAULT_SPECS_REMOTE;
}
/** Where the claude.ai Work Board export reads its JSON (machine-local, gitignored). */
export function boardDir(env = process.env) {
  return env.RF_BOARD_DIR ? resolve(env.RF_BOARD_DIR) : join(REPO_ROOT, "local-assets", "board");
}

/** The routeflow checkout the collector reads: RF_REPO_DIR (cloud clone) else this checkout. */
export function repoDir(env = process.env) {
  return env.RF_REPO_DIR ? resolve(env.RF_REPO_DIR) : REPO_ROOT;
}
/** True in the Railway container (RF_CLOUD=1). */
export function isCloud(env = process.env) {
  return env.RF_CLOUD === "1" || env.RF_CLOUD === "true";
}

export const DEFAULT_CONFIG = {
  v: 1,
  // hostname → machine id. Unknown hosts fall back to RF_MACHINE, ~/.routeflow/ops/machine, or
  // the sanitized hostname.
  machines: {},
  lanes: [
    { id: "lead", title: "Routeflow Lead", machine: "pc", areas: [] },
    { id: "sa", title: "RouteFlow SA rulings queue", machine: "pc", areas: [] },
    { id: "pc-lane", title: "RouteFlow PC lane planning", machine: "pc", areas: ["*"] },
    {
      id: "macmini",
      title: "RouteFlow Mac mini lane",
      machine: "macmini",
      areas: ["domain:catalog"],
    },
    {
      id: "macbook",
      title: "RouteFlow MacBook lane",
      machine: "macbook",
      areas: ["domain:billing", "domain:finance"],
    },
    { id: "ops-monitor", title: "RouteFlow Ops Monitor", machine: "pc", areas: ["domain:tooling"] },
    { id: "coordinator", title: "RouteFlow Coordinator", machine: "pc", areas: [] },
    { id: "owner", title: "Owner", machine: null, areas: [] },
  ],
  // Lower-cased free text (register "Lane" column, --lane values) → lane id. Longest match wins.
  laneAliases: {
    "pc lane": "pc-lane",
    "pc-lane": "pc-lane",
    "pc-l": "pc-lane",
    "mac mini": "macmini",
    macmini: "macmini",
    mm: "macmini",
    macbook: "macbook",
    mb: "macbook",
    lead: "lead",
    sa: "sa",
    architect: "sa",
    owner: "owner",
    "ops monitor": "ops-monitor",
    "ops-monitor": "ops-monitor",
  },
  thresholds: { laneSilentMin: 30, sourceStaleFactor: 3 },
};

/** Loads <specs>/ops/config.json merged over DEFAULT_CONFIG (missing/bad file → defaults). */
export function loadConfig(dir = specsDir()) {
  const p = join(dir, "ops", "config.json");
  if (!existsSync(p)) return structuredClone(DEFAULT_CONFIG);
  try {
    // Live-client names never live in the specs repo (lead ruling 10-19): see lib/mask.mjs.
    const { clientNames: _dropped, ...raw } = JSON.parse(readFileSync(p, "utf8"));
    return {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds ?? {}) },
      laneAliases: { ...DEFAULT_CONFIG.laneAliases, ...(raw.laneAliases ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

const sanitize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "unknown";

/** Machine id: RF_MACHINE → ~/.routeflow/ops/machine → config.machines[hostname] → hostname. */
export function machineId(config = DEFAULT_CONFIG, env = process.env, host = hostname()) {
  if (env.RF_MACHINE) return sanitize(env.RF_MACHINE);
  const f = join(opsHome(env), "machine");
  if (existsSync(f)) {
    const v = readFileSync(f, "utf8").trim();
    if (v) return sanitize(v);
  }
  if (config.machines?.[host]) return sanitize(config.machines[host]);
  return sanitize(host);
}

/**
 * Normalizes free text to a lane id: an exact lane id wins, then the longest alias found in the
 * text as a whole word. "unassigned" / "" / "-" → null. Unknown text → null.
 */
export function normalizeLane(text, config = DEFAULT_CONFIG) {
  if (text === null || text === undefined) return null;
  const t = String(text).toLowerCase().trim();
  if (!t || t === "-" || t.startsWith("unassigned")) return null;
  if (config.lanes.some((l) => l.id === t)) return t;
  let best = null;
  for (const [alias, id] of Object.entries(config.laneAliases)) {
    const re = new RegExp(
      `(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`,
    );
    if (re.test(t) && (!best || alias.length > best.alias.length)) best = { alias, id };
  }
  return best ? best.id : null;
}

/** Lane id for this process: explicit flag → RF_LANE → null. */
export function laneId(flag, config = DEFAULT_CONFIG, env = process.env) {
  const raw = flag ?? env.RF_LANE ?? null;
  return raw ? normalizeLane(raw, config) : null;
}
