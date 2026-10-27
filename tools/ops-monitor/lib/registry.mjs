// registry.mjs — where the ops monitor finds the bug register (B1-a2, SPEC v3.2 C6).
//
// The location comes from the vendored registry-source.json (a byte copy of
// scripts/lib/registry-source.json, pinned by scripts/registry-root.self-test.mjs). While the mode
// is "tracked" the register is read from the product repo's origin/master; in B1-c the mode flips
// and the same readers point at the specs clone's prefix instead.

import { readFileSync } from "node:fs";

const SOURCE = JSON.parse(readFileSync(new URL("./registry-source.json", import.meta.url), "utf8"));

export const REGISTRY_MODE = "tracked";
export const REGISTRY_REPO = SOURCE.repo;
export const REGISTRY_BRANCH = SOURCE.branch;
export const REGISTRY_PREFIX = SOURCE.prefix;

// Where the register sits inside the product repo while the mode is "tracked".
const TRACKED_PREFIX = ".claude/campaign";

/** Register directory inside the repo the collector reads (no trailing slash). */
export function registryDir() {
  return REGISTRY_MODE === "tracked" ? TRACKED_PREFIX : REGISTRY_PREFIX;
}

/** Thrown when the register cannot be read. "0 bugs" looks like a clean register; never return it. */
export class RegistryUnavailable extends Error {
  constructor(detail) {
    super(`bug register unavailable: ${detail}`);
    this.name = "RegistryUnavailable";
  }
}
