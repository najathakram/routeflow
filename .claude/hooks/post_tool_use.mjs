#!/usr/bin/env node
/**
 * PostToolUse quality flagger (Write|Edit|MultiEdit).
 * Pure Node — cross-platform, no subprocess. NON-BLOCKING: writes advisories to
 * stderr and exits 0. Flags common smells in the file that was just written.
 * Skips tests, e2e, generated, config, and declaration files.
 */
import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

let payload = {};
try {
  payload = JSON.parse(readStdin() || "{}");
} catch {
  process.exit(0);
}

const tool = payload.tool_name ?? payload.tool ?? "";
const filePath = payload.tool_input?.file_path ?? payload.input?.file_path ?? "";

if (!/^(Write|Edit|MultiEdit)$/.test(tool) || !filePath) process.exit(0);
if (!/\.(ts|tsx|js|jsx)$/.test(filePath)) process.exit(0);

const SKIP =
  /(\.spec\.|\.test\.|[\\/]__tests__[\\/]|[\\/]e2e[\\/]|\.d\.ts$|generated|prisma[\\/]migrations|node_modules|\.next|[\\/]dist[\\/]|[\\/]coverage[\\/]|\.config\.)/i;
if (SKIP.test(filePath)) process.exit(0);

let content = "";
try {
  content = readFileSync(filePath, "utf8");
} catch {
  process.exit(0);
}

const CHECKS = [
  [/console\.(log|debug)\(/, "debug console.log/console.debug left in source"],
  [/\bdebugger\b/, "debugger statement left in source"],
  [/:\s*any\b|\bas any\b/, "avoid `any` — prefer `unknown` + narrowing"],
  [/@ts-ignore(?!\s*\S)/, "@ts-ignore without an explanation comment"],
  [/\b(TODO|FIXME|HACK)\b/, "unresolved TODO/FIXME/HACK"],
];

const flags = [];
content.split(/\r?\n/).forEach((line, i) => {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
  for (const [re, msg] of CHECKS) {
    if (re.test(line)) flags.push(`  L${i + 1}: ${msg}`);
  }
});

if (flags.length) {
  process.stderr.write(`Quality flags in ${filePath}:\n${flags.slice(0, 12).join("\n")}\n`);
}
process.exit(0);
