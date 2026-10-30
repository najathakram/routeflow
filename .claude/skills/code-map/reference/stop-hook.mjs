#!/usr/bin/env node
/**
 * Optional Stop hook — reminds you to keep `.claude/code-map/` in sync.
 *
 * Advisory by default (exit 0 + stderr note): if tracked/untracked SOURCE files
 * changed this session but nothing under `.claude/code-map/` was touched, it prints
 * a reminder. It does NOT block. To make it blocking (so the turn won't close until
 * the map is updated), change the final `process.exit(0)` in the reminder branch to
 * `process.exit(2)` — exit 2 feeds the message back to Claude to self-correct.
 *
 * Opt in per project by wiring it into `.claude/settings.json`:
 *   { "hooks": { "Stop": [ { "hooks": [
 *       { "type": "command", "command": "node .claude/hooks/code-map-sync.mjs" }
 *   ] } ] } }
 * (Copy this file to `.claude/hooks/code-map-sync.mjs` first.)
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// No map yet → nothing to keep in sync.
if (!existsSync(".claude/code-map")) process.exit(0);

let changed = [];
try {
  const tracked = execSync("git diff --name-only HEAD", { encoding: "utf8" });
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf8" });
  changed = `${tracked}\n${untracked}`
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(0); // not a git repo / git unavailable
}

const SKIP = /(node_modules|\.next|[/]dist[/]|[/]build[/]|[/]coverage[/]|\.turbo|package-lock)/;
const isSource = (f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|vue|svelte)$/.test(f);

const sourceChanged = changed.filter((f) => isSource(f) && !SKIP.test(f));
const mapTouched = changed.some((f) => f.startsWith(".claude/code-map/"));

if (sourceChanged.length > 0 && !mapTouched) {
  const sample = sourceChanged
    .slice(0, 8)
    .map((f) => `  - ${f}`)
    .join("\n");
  process.stderr.write(
    "code-map reminder: source changed but `.claude/code-map/` was not updated.\n" +
      "Surgically update the affected area entries + `_meta.json` (see the code-map skill).\n" +
      `Changed source (first ${Math.min(8, sourceChanged.length)} of ${sourceChanged.length}):\n${sample}\n`,
  );
  process.exit(0); // advisory; change to 2 to block
}

process.exit(0);
