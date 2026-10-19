// Per-session "turn actions" log shared by the PostToolUse recorder (ops-post-push.mjs) and
// the Stop gate (ops-stop.mjs). One JSON object per line in
// <opsHome>/turn-actions/<session>.jsonl. Tiny IO helpers; callers decide how to fail (both
// hooks fail open).
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const KEEP_ARCHIVES = 5;

/** Session ids come from the host; keep only filename-safe characters. */
export function sanitizeSessionId(sessionId) {
  const s = String(sessionId ?? "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .slice(0, 80);
  return s || "unknown";
}

export function actionsFile(home, sessionId) {
  return join(home, "turn-actions", `${sanitizeSessionId(sessionId)}.jsonl`);
}

export function appendAction(file, action) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(action)}\n`);
}

/** Missing file or bad lines never throw: returns the parseable actions (possibly []). */
export function readActions(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

/** Renames the actions file to `<file>.done-<ms>`, drops its .blocks file, keeps the last 5. */
export function archiveActions(file, now = Date.now()) {
  try {
    renameSync(file, `${file}.done-${now}`);
  } catch {
    return;
  }
  try {
    rmSync(`${file}.blocks`, { force: true });
  } catch {
    // ignore
  }
  try {
    const base = `${basename(file)}.done-`;
    const old = readdirSync(dirname(file))
      .filter((n) => n.startsWith(base))
      .sort((a, b) => Number(b.slice(base.length)) - Number(a.slice(base.length)));
    for (const n of old.slice(KEEP_ARCHIVES)) rmSync(join(dirname(file), n), { force: true });
  } catch {
    // ignore
  }
}
