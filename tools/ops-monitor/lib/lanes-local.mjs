// Per-checkout lane identity. `rf whoami --lane <id>` records which lane works in which
// directory in <opsHome>/lanes.json ({ "<normalized absolute dir>": "<lane>" }); every `rf` call
// and every hook then resolves the lane from the working directory when neither --lane nor RF_LANE
// is given. Machine-local file, never committed. Sync IO, no network, no git (hooks call this).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { normalizeLane, opsHome } from "./config.mjs";

export const LANES_FILE = "lanes.json";

export const lanesFile = (home) => join(home, LANES_FILE);

/** Absolute, forward-slash, no trailing slash; lower-cased on Windows (case-insensitive paths). */
export function normalizeCwd(p, platform = process.platform) {
  let s = resolve(String(p)).replace(/\\/g, "/");
  while (s.length > 1 && s.endsWith("/") && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return platform === "win32" ? s.toLowerCase() : s;
}

/** The recorded map; a missing or damaged file is an empty map. */
export function readLanes(home) {
  try {
    const v = JSON.parse(readFileSync(lanesFile(home), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Records `cwd` -> `lane` (atomic temp + rename). Returns the normalized key. */
export function setLane(home, cwd, lane, platform = process.platform) {
  const key = normalizeCwd(cwd, platform);
  const map = readLanes(home);
  map[key] = lane;
  mkdirSync(home, { recursive: true });
  const file = lanesFile(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
  renameSync(tmp, file);
  return key;
}

/**
 * Nearest directory at or above `cwd` holding a `.git` (a directory, or the file a linked
 * worktree has). fs only, no git call. Null when there is none up the tree.
 */
export function checkoutRoot(cwd) {
  let dir = resolve(String(cwd));
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Lane for a working directory: RF_LANE, else the lanes.json entry for the cwd's OWN checkout
 * root (nearest ancestor with a .git). A worktree nested inside another checkout (every lane and
 * agent worktree lives under the lead's .claude/worktrees) never inherits the parent's lane.
 * With no .git up the tree, the older rule applies: longest path-prefix match, else null.
 * With a `config` the result is normalized to a configured lane id (unknown -> null).
 */
export function laneForCwd(cwd, env = process.env, { config, home, platform } = {}) {
  const raw = (v) => {
    const s = String(v ?? "")
      .trim()
      .toLowerCase();
    if (!s) return null;
    return config ? normalizeLane(s, config) : s;
  };
  if (env.RF_LANE) return raw(env.RF_LANE);
  if (!cwd) return null;
  const map = readLanes(home ?? opsHome(env));
  const top = checkoutRoot(cwd);
  if (top) {
    const key = normalizeCwd(top, platform);
    for (const [dir, lane] of Object.entries(map)) {
      if (normalizeCwd(dir, platform) === key) return raw(lane);
    }
    return null;
  }
  const here = normalizeCwd(cwd, platform);
  let best = null;
  for (const [dir, lane] of Object.entries(map)) {
    const key = normalizeCwd(dir, platform);
    if (here === key || here.startsWith(key.endsWith("/") ? key : `${key}/`)) {
      if (!best || key.length > best.key.length) best = { key, lane };
    }
  }
  return best ? raw(best.lane) : null;
}
