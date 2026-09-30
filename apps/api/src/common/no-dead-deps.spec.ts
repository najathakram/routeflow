/**
 * T2 (item 11, PR-14): static dead-dependency tripwire.
 *
 * Four packages were removed as verified zero-reference dead weight (2026-09-03 survey, this
 * PR): `zustand` from `apps/web` (web state is TanStack Query + context — mobile keeps its own
 * copy, a real dependent, and is deliberately NOT covered by the zustand checks below), and
 * `@nestjs/axios` / `passport-google-oauth20` / `@types/passport-google-oauth20` from
 * `apps/api` (outbound HTTP goes through vendor SDKs; Google OAuth is `google-auth-library`'s
 * `OAuth2Client` in `auth/google-oauth.service.ts`, not a Passport `GoogleStrategy`).
 *
 * Each check has two halves: the manifest no longer DECLARES the package, and nothing in the
 * app's source tree still IMPORTS it (a manifest edit alone doesn't prove the code doesn't need
 * it). A guard in the other direction pins that mobile's own zustand — a real, used dependency —
 * was not collaterally removed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, sep } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

function readManifest(relPath: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8"));
}

function declaresPackage(manifest: Manifest, pkg: string): boolean {
  return Boolean(manifest.dependencies?.[pkg] || manifest.devDependencies?.[pkg]);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    // Exclude test files themselves — this suite's own fixture strings (below) legitimately
    // contain import-shaped text naming the very packages under test.
    if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(entry)) continue;
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Matches `from "pkg"`, `require("pkg")`, or `import("pkg")` — pkg may itself contain `/`
 * (scoped packages), so the match is anchored on the quote, not on word boundaries. */
function importsPackage(source: string, pkg: string): boolean {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:from|require|import)\\s*\\(?\\s*["']${escaped}(?:/[^"']*)?["']`);
  return pattern.test(source);
}

function findImporters(files: string[], pkg: string): string[] {
  return files
    .filter((file) => importsPackage(readFileSync(file, "utf8"), pkg))
    .map((file) => file.split(sep).join("/"));
}

describe("dead dependencies stay removed (T2)", () => {
  const webManifest = "apps/web/package.json";
  const apiManifest = "apps/api/package.json";
  const webFiles = walk(join(REPO_ROOT, "apps/web/app"))
    .concat(walk(join(REPO_ROOT, "apps/web/components")))
    .concat(walk(join(REPO_ROOT, "apps/web/hooks")))
    .concat(walk(join(REPO_ROOT, "apps/web/lib")));
  const apiFiles = walk(join(REPO_ROOT, "apps/api/src")).concat(
    walk(join(REPO_ROOT, "apps/api/scripts")),
  );

  it("apps/web/package.json no longer declares zustand", () => {
    expect(declaresPackage(readManifest(webManifest), "zustand")).toBe(false);
  });

  it("no web source file under app/components/hooks/lib imports zustand", () => {
    expect(findImporters(webFiles, "zustand")).toEqual([]);
  });

  it.each(["@nestjs/axios", "passport-google-oauth20", "@types/passport-google-oauth20"])(
    "apps/api/package.json no longer declares %s",
    (pkg) => {
      expect(declaresPackage(readManifest(apiManifest), pkg)).toBe(false);
    },
  );

  it.each(["@nestjs/axios", "passport-google-oauth20"])(
    "no API source file under src/scripts imports %s",
    (pkg) => {
      expect(findImporters(apiFiles, pkg)).toEqual([]);
    },
  );

  it("removing @nestjs/axios did not leave a stray HttpModule/HttpService import", () => {
    expect(findImporters(apiFiles, "@nestjs/axios")).toEqual([]);
    const offenders = apiFiles.filter((file) => {
      const src = readFileSync(file, "utf8");
      return /\bHttpModule\b|\bHttpService\b/.test(src) && /@nestjs\/axios/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("regression guard: mobile keeps its own zustand — the removal was web-only", () => {
    const mobileManifest = readManifest("apps/mobile/package.json");
    expect(declaresPackage(mobileManifest, "zustand")).toBe(true);
  });

  it("regression guard: mobile's react-test-renderer pin is untouched by this change", () => {
    const mobileManifest = readManifest("apps/mobile/package.json");
    expect(mobileManifest.devDependencies?.["react-test-renderer"]).toBeDefined();
  });

  it("sanity: the walk actually found files to scan (an empty result must mean 'no offenders', not 'nothing read')", () => {
    expect(webFiles.length).toBeGreaterThan(0);
    expect(apiFiles.length).toBeGreaterThan(0);
  });

  it("importsPackage() flags a fixture import and ignores an unrelated one", () => {
    expect(importsPackage('import { create } from "zustand";', "zustand")).toBe(true);
    expect(importsPackage('import axios from "axios";', "zustand")).toBe(false);
    expect(importsPackage('import { HttpModule } from "@nestjs/axios";', "@nestjs/axios")).toBe(
      true,
    );
  });
});
