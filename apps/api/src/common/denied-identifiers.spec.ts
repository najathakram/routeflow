/**
 * Local, git-ignored tripwire for scrubbing real client identifiers (tenant
 * slugs, business names, emails) out of the repo before a public CI window —
 * see CLAUDE.md "Test tenants & real-client data (policy)" and
 * scripts/lib/test-tenants.cjs for the standing test-tenant allow-list.
 *
 * The denied list itself is NEVER committed: while scrubbing, put the real
 * identifiers being removed (one per line) in the gitignored
 * local-assets/security/denied-identifiers.txt, run this spec, and it names
 * every file where a denied string still survives. Missing or empty file is
 * a no-op PASS with a console warning — every other contributor, and CI on a
 * fresh clone, never has this local file, so the guard is inert for them.
 *
 * Lives in the API project because the repo has no root test runner
 * (CLAUDE.md "DO NOT introduce ... a root-level test runner").
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, extname, relative, sep } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const DENY_LIST_PATH = join(REPO_ROOT, "local-assets", "security", "denied-identifiers.txt");

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "out",
  ".vercel",
  // Where the deny list itself (and anything else local/personal) lives —
  // never the thing this guard scans.
  "local-assets",
]);

// Text-ish source/doc extensions worth scanning. Binary/lockfile/image types
// are skipped for both correctness (no false hits inside compiled/binary
// blobs) and speed.
const SCANNED_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".mdx",
  ".json",
  ".yml",
  ".yaml",
  ".html",
  ".txt",
]);

function readDenyList(): string[] {
  if (!existsSync(DENY_LIST_PATH)) return [];
  return readFileSync(DENY_LIST_PATH, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function collectScannedFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectScannedFiles(full, out);
      continue;
    }
    if (!SCANNED_EXTS.has(extname(entry.name))) continue;
    out.push(full);
  }
  return out;
}

describe("denied client identifiers (local, gitignored tripwire)", () => {
  const denied = readDenyList();

  if (denied.length === 0) {
    it("has no denied identifiers configured — no-op pass", () => {
      // eslint-disable-next-line no-console
      console.warn(
        `[denied-identifiers] ${DENY_LIST_PATH} is missing or empty — this guard is a no-op. ` +
          "Add real identifiers (one per line, never committed) before a public CI window to " +
          "verify a scrub is complete.",
      );
      expect(true).toBe(true);
    });
    return;
  }

  const files = collectScannedFiles(REPO_ROOT);

  it("finds a non-trivial source tree to scan", () => {
    // A silent zero-file walk would make every assertion below vacuously green.
    expect(files.length).toBeGreaterThan(500);
  });

  it.each(denied)("%s does not appear anywhere in the scanned tree", (identifier) => {
    // Word-boundary match, not a bare substring — a short slug is also a
    // substring of plenty of unrelated identifiers (e.g. a 4-letter slug
    // embedded inside a camelCase helper name), and \b still matches around
    // identifiers containing non-word chars
    // (hyphens, @, dots) since it only anchors on the FIRST/LAST character.
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    const offenders = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(REPO_ROOT, file).split(sep).join("/"));

    expect(offenders).toEqual([]);
  });
});
