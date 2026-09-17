/**
 * Static guard (B — fix/web-platform-admin-layout-export) — every `layout.tsx`
 * anywhere under `app/` exports ONLY `default` / `metadata` / `viewport`.
 *
 * `(platform-admin)/layout.tsx` re-exported `superAdminClient` from `@/lib/admin-api`
 * "for backwards compat" — a non-default export from an App Router layout, which trips
 * Next's typed-routes check in any worktree that has run `next dev` (masked in prod by
 * `ignoreBuildErrors`). This walks the tree rather than asserting per file, so a NEW
 * stray export added to any layout fails here instead of surfacing only as a
 * dev-only typed-routes error in someone else's worktree.
 *
 * Precedent: `components/no-next-image.test.ts`.
 */

import * as fs from "fs";
import * as path from "path";

const WEB_ROOT = path.resolve(__dirname, "..");
/**
 * B452 followups (d): Next's own legal layout/route-segment exports, alongside
 * the App Router trio (default/metadata/viewport) this guard already allowed —
 * `generateMetadata`/`generateViewport` are the async-computed forms of
 * metadata/viewport, and the rest are route-segment config Next reads
 * statically (never a "backwards compat" re-export like the B this guard
 * exists for).
 */
const ALLOWED_EXPORTS = new Set([
  "default",
  "metadata",
  "viewport",
  "generateMetadata",
  "generateViewport",
  "dynamic",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
]);

/**
 * One export per line, matching how every layout.tsx in this repo is written.
 * `(?:async\s+)?` before `function` so `export async function generateMetadata()`
 * — the standard shape for that export — is actually captured, not silently
 * skipped as a non-match (B452 followups (d)).
 */
const EXPORT_LINE =
  /^export\s+(?:default\b|const\s+(\w+)|let\s+(\w+)|var\s+(\w+)|(?:async\s+)?function\s+(\w+)|class\s+(\w+)|\{([^}]+)\})/;

function findLayoutFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      findLayoutFiles(full, out);
      continue;
    }
    if (entry.name === "layout.tsx") out.push(full);
  }
  return out;
}

/** Names exported by a single `export ...` line ("default" for `export default ...`). */
function exportNamesFromLine(line: string): string[] {
  const m = EXPORT_LINE.exec(line.trim());
  if (!m) return [];
  if (/^export\s+default\b/.test(line.trim())) return ["default"];
  const [, constName, letName, varName, fnName, className, namedList] = m;
  const single = constName ?? letName ?? varName ?? fnName ?? className;
  if (single) return [single];
  if (namedList) {
    return namedList
      .split(",")
      .map((clause) => clause.trim())
      .filter(Boolean)
      .map((clause) => {
        const asMatch = /\bas\s+(\w+)\b/.exec(clause);
        return asMatch ? asMatch[1] : clause.split(/\s+/)[0];
      });
  }
  return [];
}

const LAYOUT_FILES = findLayoutFiles(path.join(WEB_ROOT, "app"));

describe("app/**/layout.tsx exports only default/metadata/viewport", () => {
  it("finds the layout files it is meant to guard", () => {
    expect(LAYOUT_FILES.length).toBeGreaterThanOrEqual(6);
    expect(LAYOUT_FILES).toContain(path.join(WEB_ROOT, "app", "layout.tsx"));
  });

  it("no layout.tsx exports anything outside default/metadata/viewport", () => {
    const offenders: string[] = [];
    for (const file of LAYOUT_FILES) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const names = lines.flatMap(exportNamesFromLine);
      const stray = names.filter((name) => !ALLOWED_EXPORTS.has(name));
      if (stray.length > 0) {
        offenders.push(
          `${path.relative(WEB_ROOT, file).split(path.sep).join("/")}: ${stray.join(", ")}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the extractor catches the exact B pattern this guard exists for", () => {
    expect(exportNamesFromLine('export { superAdminClient } from "@/lib/admin-api";')).toEqual([
      "superAdminClient",
    ]);
    expect(exportNamesFromLine('export { foo as bar } from "./x";')).toEqual(["bar"]);
    expect(exportNamesFromLine("export default function Foo() {}")).toEqual(["default"]);
    expect(exportNamesFromLine("export const metadata: Metadata = {")).toEqual(["metadata"]);
    expect(exportNamesFromLine("export const viewport: Viewport = {")).toEqual(["viewport"]);
    expect(exportNamesFromLine("  // not an export line")).toEqual([]);
  });

  it("B452 followups (d): the extractor captures export async function (previously a silent non-match)", () => {
    expect(exportNamesFromLine("export async function generateMetadata() {")).toEqual([
      "generateMetadata",
    ]);
    expect(exportNamesFromLine("export async function generateViewport() {")).toEqual([
      "generateViewport",
    ]);
  });

  it("B452 followups (d): Next's legal layout/route-segment exports are allowed, not flagged as stray", () => {
    const legal = [
      'export const dynamic = "force-dynamic";',
      "export const revalidate = 60;",
      'export const fetchCache = "force-no-store";',
      'export const runtime = "nodejs";',
      'export const preferredRegion = "auto";',
      "export const maxDuration = 30;",
      "export async function generateMetadata() {",
      "export async function generateViewport() {",
    ];
    for (const line of legal) {
      const stray = exportNamesFromLine(line).filter((name) => !ALLOWED_EXPORTS.has(name));
      expect(stray).toEqual([]);
    }
  });
});
