// plane-bridge-config.mjs — loads and validates plane-bridge.json (the tracked ownership switch).
// plane-sync.mjs imports bridgeClaimsTarget() only; it never throws on a bad bridge file.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const selfTest = () => process.env.PLANE_SYNC_SELF_TEST === "1";

// PLANE_BRIDGE_CONFIG / _BASE_URL / _TOKEN_FILE are test-only overrides, honoured only when
// PLANE_SYNC_SELF_TEST=1 is also set (house rule, plane-client.mjs).
export function bridgeConfigPath() {
  if (selfTest() && process.env.PLANE_BRIDGE_CONFIG) return process.env.PLANE_BRIDGE_CONFIG;
  return join(HERE, "plane-bridge.json");
}

function invalid(field) {
  return new Error(`plane-bridge.json invalid: ${field}`);
}

export function loadBridgeConfig(path = bridgeConfigPath()) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw invalid("unreadable or not JSON");
  }
  const t = cfg?.target;
  for (const k of ["baseUrl", "workspace", "tokenFile"]) {
    if (typeof t?.[k] !== "string" || !t[k]) throw invalid(`target.${k}`);
  }
  if (!cfg.registries || typeof cfg.registries !== "object") throw invalid("registries");
  for (const [name, reg] of Object.entries(cfg.registries)) {
    const at = `registries.${name}`;
    if (reg?.owner !== "registry" && reg?.owner !== "plane") throw invalid(`${at}.owner`);
    if (!reg.project?.identifier || !reg.project?.name) throw invalid(`${at}.project`);
    if (!Array.isArray(reg.states) || reg.states.length === 0) throw invalid(`${at}.states`);
    const names = new Set(reg.states.map((s) => s?.name));
    for (const s of reg.states) {
      if (!s?.name || !s.group || !s.color) throw invalid(`${at}.states`);
    }
    for (const [k, v] of Object.entries(reg.stateByLedger ?? {})) {
      if (!names.has(v)) throw invalid(`${at}.stateByLedger.${k}`);
    }
    if (!reg.stateByLedger) throw invalid(`${at}.stateByLedger`);
    if (!names.has(reg.noStatusState)) throw invalid(`${at}.noStatusState`);
    if (!reg.ledgerByState) throw invalid(`${at}.ledgerByState`);
    for (const [k, v] of Object.entries(reg.ledgerByState)) {
      if (!names.has(k)) throw invalid(`${at}.ledgerByState.${k}`);
      if (v !== null && typeof v !== "string") throw invalid(`${at}.ledgerByState.${k}`);
    }
  }
  return cfg;
}

export function bridgeBaseUrl(cfg) {
  if (selfTest() && process.env.PLANE_BRIDGE_BASE_URL) return process.env.PLANE_BRIDGE_BASE_URL;
  return cfg.target.baseUrl;
}

export function bridgeTokenPath(cfg) {
  if (selfTest() && process.env.PLANE_BRIDGE_TOKEN_FILE) return process.env.PLANE_BRIDGE_TOKEN_FILE;
  const f = cfg.target.tokenFile;
  return f === "~" || f.startsWith("~/") || f.startsWith("~\\") ? join(homedir(), f.slice(1)) : f;
}

// Trimmed file content, or null when the file is missing/empty. Never logs.
export function readBridgeToken(cfg) {
  try {
    const p = bridgeTokenPath(cfg);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8").trim() || null;
  } catch {
    return null;
  }
}

const normalize = (u) =>
  String(u ?? "")
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace("//127.0.0.1", "//localhost");

export function bridgeClaimsTarget(baseUrl, slug) {
  try {
    const cfg = loadBridgeConfig();
    return normalize(baseUrl) === normalize(bridgeBaseUrl(cfg)) && slug === cfg.target.workspace;
  } catch {
    return false;
  }
}
