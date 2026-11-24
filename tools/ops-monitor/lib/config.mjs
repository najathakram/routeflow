// Paths, machine/lane identity and the default fleet config for the ops monitor.
// The data never lives in this repo: events and views go to a tool-owned clone of the
// private routeflow-specs repo (default ~/.routeflow/ops/routeflow-specs), so the CLI and
// the monitor never touch a human's working checkout.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLES } from "./schema.mjs";

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
    { id: "lead", title: "Routeflow Lead", machine: "windows", areas: [] },
    { id: "sa", title: "RouteFlow Senior Architect", machine: "windows", areas: [] },
    {
      id: "win-heavy",
      title: "RouteFlow Windows heavy lane",
      machine: "windows",
      areas: ["domain:finance"],
    },
    {
      id: "win-billing",
      title: "RouteFlow Windows billing lane",
      machine: "windows",
      areas: ["domain:billing"],
    },
    { id: "win-salvage", title: "RouteFlow Windows salvage lane", machine: "windows", areas: [] },
    {
      id: "macmini",
      title: "RouteFlow Mac mini lane",
      machine: "macmini",
      areas: ["domain:catalog"],
    },
    {
      id: "mm-landing",
      title: "RouteFlow Mac mini landing lane",
      machine: "macmini",
      areas: ["domain:tooling"],
    },
    {
      id: "mm-counter",
      title: "RouteFlow Counter lane",
      machine: "windows",
      areas: ["domain:counter"],
    },
    {
      id: "macbook",
      title: "RouteFlow MacBook lane",
      machine: "macbook",
      areas: ["domain:restrictions"],
    },
    { id: "owner", title: "Owner", machine: null, areas: [] },
  ],
  // Lower-cased free text (register "Lane" column, --lane values) → lane id. Longest match wins.
  // Every target must be a lane id above (config.test.mjs pins it).
  laneAliases: {
    "pc lane": "lead",
    "pc-lane": "lead",
    "pc-l": "lead",
    pc: "lead",
    coordinator: "lead",
    "mac mini": "macmini",
    macmini: "macmini",
    mm: "macmini",
    macbook: "macbook",
    mb: "macbook",
    lead: "lead",
    sa: "sa",
    architect: "sa",
    owner: "owner",
    "ops monitor": "mm-landing",
    "ops-monitor": "mm-landing",
    landing: "mm-landing",
    "landing lane": "mm-landing",
    "mac mini landing": "mm-landing",
    "mm-landing": "mm-landing",
    r7b: "mm-counter",
    counter: "mm-counter",
    "counter lane": "mm-counter",
    "mm-counter": "mm-counter",
    windows: "win-heavy",
    "windows heavy": "win-heavy",
    win: "win-heavy",
    "win-heavy": "win-heavy",
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
    const merged = {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      thresholds: { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds ?? {}) },
      laneAliases: { ...DEFAULT_CONFIG.laneAliases, ...(raw.laneAliases ?? {}) },
    };
    // The file's lanes replace the defaults, so a merged alias may point at a lane it omits.
    const ids = new Set((merged.lanes ?? []).map((l) => l.id));
    merged.laneAliases = Object.fromEntries(
      Object.entries(merged.laneAliases).filter(([, target]) => ids.has(target)),
    );
    return merged;
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
 * The configured lane an id stands for: a configured id is itself, else the lane its alias
 * names when that lane is configured, else null (unknown). One resolver for alarms and snapshot.
 */
export function resolveLaneId(id, config = DEFAULT_CONFIG) {
  if (!id) return null;
  const lanes = config?.lanes ?? [];
  if (lanes.some((l) => l.id === id)) return id;
  const target = config?.laneAliases?.[id] ?? config?.laneAliases?.[String(id).toLowerCase()];
  return target && lanes.some((l) => l.id === target) ? target : null;
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

// ── team members (specs ops/config.json `members`) ──────────────────────────
// { id, name, machine, lanes: [lane ids], role: builder | tester | reviewer }. A member is a person
// on their own computer and Claude account; their id is the name their events are written under.

const MEMBER_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

function memberError(m, config, seen) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "a member must be an object";
  if (typeof m.id !== "string" || !MEMBER_ID_RE.test(m.id))
    return `member id ${JSON.stringify(m.id)} must be lower-case letters, digits and dashes`;
  if (seen.has(m.id)) return `member "${m.id}" is listed twice`;
  if ((config.lanes ?? []).some((l) => l.id === m.id))
    return `member "${m.id}" is also a lane id (a mention would be ambiguous)`;
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 80)
    return `member "${m.id}" needs a display name (1-80 characters)`;
  if (!ROLES.includes(m.role)) return `member "${m.id}": role must be builder, tester or reviewer`;
  if (m.machine !== undefined && m.machine !== null && typeof m.machine !== "string")
    return `member "${m.id}": machine must be a machine id or null`;
  if (!Array.isArray(m.lanes)) return `member "${m.id}": lanes must be a list of lane ids`;
  const bad = m.lanes.find((l) => !(config.lanes ?? []).some((x) => x.id === l));
  if (bad !== undefined) return `member "${m.id}": unknown lane ${JSON.stringify(bad)}`;
  return null;
}

/** Why each bad `members` entry is ignored (for `rf doctor`). Never throws. */
export function memberProblems(config = DEFAULT_CONFIG) {
  const list = config?.members;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["members must be a list"];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const err = memberError(m, config, seen);
    if (err) out.push(err);
    else seen.add(m.id);
  }
  return out;
}

/** The valid members, in file order (bad entries are skipped; memberProblems says why). */
export function membersOf(config = DEFAULT_CONFIG) {
  const list = Array.isArray(config?.members) ? config.members : [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (memberError(m, config, seen)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      name: m.name.trim(),
      machine: m.machine ?? null,
      lanes: [...m.lanes],
      role: m.role,
    });
  }
  return out;
}

/** The member with this id (case-insensitive), or null. */
export function findMember(config, id) {
  if (typeof id !== "string" || !id) return null;
  const k = id.trim().toLowerCase();
  return membersOf(config).find((m) => m.id === k) ?? null;
}

/** A member's display name, or null when the id is not a member (a lane, a hook, a machine). */
export const memberName = (config, id) => findMember(config, id)?.name ?? null;

export const MEMBER_FILE = "member";

/** The member this computer works as: RF_MEMBER, else <opsHome>/member, else null (unchecked). */
export function memberId(env = process.env) {
  const raw = env.RF_MEMBER ?? null;
  if (raw !== null) return String(raw).trim().toLowerCase() || null;
  const f = join(opsHome(env), MEMBER_FILE);
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").trim().toLowerCase() || null;
}

/** Lane id for this process: explicit flag → RF_LANE → null. */
export function laneId(flag, config = DEFAULT_CONFIG, env = process.env) {
  const raw = flag ?? env.RF_LANE ?? null;
  return raw ? normalizeLane(raw, config) : null;
}
