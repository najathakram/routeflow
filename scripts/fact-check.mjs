#!/usr/bin/env node
// fact-check.mjs (R0) — red-first stub: the self-test must fail on this before the checker is written.
import { fileURLToPath } from "node:url";
export const FACT_CHECK_MODE = "warn";
export function checkFacts() {
  return { hits: [], unverified: [] };
}
export function fixtureSources() {
  return {};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(process.argv.includes("--nope") ? 2 : 0);
