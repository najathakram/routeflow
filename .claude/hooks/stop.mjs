#!/usr/bin/env node
/**
 * Stop gate — fast, changed-files-only formatting check (monorepo-safe, < 10s).
 *
 * Runs `prettier --check` on the changed/untracked TS/JS source files only.
 * Blocks turn close (exit 2) with a fix list if any are unformatted.
 *
 * Why prettier-only (no eslint here): ESLint flat config resolves from the
 * current working directory, and this repo has NO root eslint.config — eslint
 * only runs per-workspace via `npm run lint` / Turbo. tsc is likewise excluded
 * (too slow/fragile per-file with Prisma); type-checks live in the pre-push hook.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

// Invoke prettier directly via node — this repo's root has no node_modules/.bin
// shim, so `npx prettier` fails on Windows. Fall back to npx where the shim exists.
function prettierCli() {
  const local = "node_modules/prettier/bin/prettier.cjs";
  return existsSync(local) ? `node "${local}"` : "npx prettier";
}

function sh(cmd) {
  try {
    return { code: 0, out: execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

let changed = [];
try {
  const tracked = execSync("git diff --name-only HEAD", { encoding: "utf8" });
  const untracked = execSync("git ls-files --others --exclude-standard", { encoding: "utf8" });
  changed = `${tracked}\n${untracked}`
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter(Boolean);
} catch {
  process.exit(0); // not a git repo / git unavailable — nothing to gate
}

const SKIP = /(node_modules|\.next|[/]dist[/]|[/]build[/]|[/]coverage[/]|\.turbo)/;
const source = changed.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f) && !SKIP.test(f));
if (source.length === 0) process.exit(0);

const list = source.map((f) => `"${f}"`).join(" ");
const res = sh(`${prettierCli()} --check ${list}`);

if (res.code !== 0) {
  const detail = res.out.trim().split(/\r?\n/).slice(0, 25).join("\n");
  process.stderr.write(
    `Stop gate: unformatted source files. Run \`npm run format\` (or \`npx prettier --write\`):\n\n${detail}\n`,
  );
  process.exit(2); // block close; stderr is fed back to Claude to self-correct
}
process.exit(0);
