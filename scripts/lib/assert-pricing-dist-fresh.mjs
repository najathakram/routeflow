// Shared helper (Senior Architect ruling 2026-09-22, SA-076a Ruling 1) -- every production script
// that imports @routeflow/pricing calls `assertPricingDistFresh()` before its first read of that
// package. `dist/` is uncommitted build output; nothing normally proves it was rebuilt from the
// src a reviewer actually read. A stale dist (edited src, a forgotten `npm run build`) must be a
// REFUSAL, not a silently-wrong write -- rebuilding as a preflight step is the operator's
// routine, but this stamp check is the actual control.
//
// The stamp is a content hash of `packages/pricing/src` (sorted file list + bytes, NOT git
// state -- a dirty tree stamps honestly) plus the package version, written to
// `packages/pricing/dist/build-info.json` by the package's own `npm run build` (see
// `packages/pricing/package.json`'s build script, which calls `writeStamp` from here so the
// build and the assertion never drift onto two different hash algorithms).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(full);
  }
  return out.sort((a, b) =>
    relative(base, a).split(sep).join("/").localeCompare(relative(base, b).split(sep).join("/")),
  );
}

/** sha256 over every file under `srcDir`, sorted by its path relative to `srcDir` (forward
 *  slashes, so the hash is identical on Windows and posix) -- path then a NUL then the file's own
 *  bytes then a NUL, per file, so no two file layouts can collide onto the same digest. */
export function computeSrcHash(srcDir) {
  const files = listFiles(srcDir);
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(relative(srcDir, f).split(sep).join("/"));
    hash.update("\0");
    hash.update(readFileSync(f));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function stampPath(pricingRoot) {
  return join(pricingRoot, "dist", "build-info.json");
}

/** Called by `packages/pricing`'s own `npm run build`, right after `tsc`, with `pricingRoot` =
 *  `packages/pricing` (npm runs package scripts with that cwd). Returns the stamp it wrote. */
export function writeStamp(pricingRoot) {
  const srcDir = join(pricingRoot, "src");
  const pkg = JSON.parse(readFileSync(join(pricingRoot, "package.json"), "utf8"));
  const stamp = {
    srcHash: computeSrcHash(srcDir),
    version: pkg.version,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(stampPath(pricingRoot), JSON.stringify(stamp, null, 2));
  return stamp;
}

/** Refuses (throws, `{refuse: true}`) when the stamp is missing or its `srcHash` no longer
 *  matches a fresh hash of the checkout's own `packages/pricing/src` -- an old dist, or src
 *  edited after the last build. Returns the stamp (unchanged) on success, for a caller (the B681
 *  routine) that wants to record it in a plan file. */
export function assertPricingDistFresh(pricingRoot) {
  const srcDir = join(pricingRoot, "src");
  const path = stampPath(pricingRoot);
  if (!existsSync(path)) {
    throw Object.assign(
      new Error(
        `@routeflow/pricing has no dist/build-info.json stamp -- run "npm run build -w packages/pricing" first`,
      ),
      { refuse: true },
    );
  }
  const stamp = JSON.parse(readFileSync(path, "utf8"));
  const actual = computeSrcHash(srcDir);
  if (stamp.srcHash !== actual) {
    throw Object.assign(
      new Error(
        `@routeflow/pricing's dist is STALE (stamped ${stamp.srcHash.slice(0, 12)}, src hashes to ${actual.slice(0, 12)} now) -- rebuild it: "npm run build -w packages/pricing"`,
      ),
      { refuse: true },
    );
  }
  return stamp;
}
