import * as fs from "fs";
import * as path from "path";
import { API_ERROR_CODES as API_LOCAL } from "./api-error-codes";

/**
 * #2163 (L-072 pattern): the machine-readable error codes web and mobile branch on live in
 * `packages/types/api/error-codes.ts` (`API_ERROR_CODES`). The API keeps a local literal copy
 * (`common/api-error-codes.ts`) because it never value-imports `@routeflow/types` at runtime (see
 * `no-runtime-workspace-imports.spec.ts`). This spec pins:
 *   1. the local copy equals the shared object: same keys, same values;
 *   2. no production source in apps/api/src, apps/web or apps/mobile spells one of these codes
 *      as a bare string literal (comments excluded). Every throw site and every client matcher
 *      goes through the named constant, so a rename is one edit that the compiler follows.
 *   3. each code is still used by at least one API source file outside the constants module, so
 *      a code no server path sends any more is noticed instead of silently kept.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readShared(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("@routeflow/types") as Record<string, unknown>).API_ERROR_CODES as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

const CONSTANTS_FILE = path.join("apps", "api", "src", "common", "api-error-codes.ts");
const SCAN_ROOTS = ["apps/api/src", "apps/web", "apps/mobile"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "e2e",
  "__tests__",
  ".expo",
  "coverage",
]);
const TEST_FILE = /\.(spec|test)\.[cm]?[tj]sx?$/;
const SOURCE_FILE = /\.[cm]?[tj]sx?$/;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/** Source text with block and line comments blanked out, so a code named in prose never counts. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const productionFiles = SCAN_ROOTS.flatMap((root) => {
  const out: string[] = [];
  const abs = path.join(REPO_ROOT, root);
  if (fs.existsSync(abs)) walk(abs, out);
  return out;
});
const sources = productionFiles.map((file) => ({
  rel: path.relative(REPO_ROOT, file),
  text: withoutComments(fs.readFileSync(file, "utf8")),
}));

describe("API error codes: local copy = shared list (#2163, L-072)", () => {
  it("apps/api's API_ERROR_CODES equals @routeflow/types' API_ERROR_CODES", () => {
    expect(API_LOCAL).toEqual(readShared());
  });

  it("apps/mobile's jest stub of @routeflow/types carries the same API_ERROR_CODES", () => {
    // The mobile jest config maps @routeflow/types to a hand stub (see its header), so a code
    // added here and not there would read as undefined in mobile tests only.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stub = require(
      path.join(REPO_ROOT, "apps/mobile/__tests__/__mocks__/@routeflow/types.js"),
    ) as Record<string, unknown>;
    expect(stub.API_ERROR_CODES).toEqual(readShared());
  });

  it("the scan actually covered all three apps (guards a path typo turning the scan vacuous)", () => {
    for (const root of SCAN_ROOTS) {
      expect(sources.some((s) => s.rel.startsWith(root))).toBe(true);
    }
  });
});

describe("API error codes: no bare string literal in production source (#2163)", () => {
  it.each(Object.entries(API_LOCAL))(
    "%s (%s) is only ever spelled in the constants module",
    (_key, code) => {
      const literal = new RegExp(`["'\`]${code}["'\`]`);
      const offenders = sources
        .filter((s) => s.rel !== CONSTANTS_FILE && literal.test(s.text))
        .map((s) => s.rel);
      expect(offenders).toEqual([]);
    },
  );
});

describe("API error codes: every code is still sent by the API (#2163)", () => {
  it.each(Object.keys(API_LOCAL))(
    "API_ERROR_CODES.%s is referenced by an API source file",
    (key) => {
      const users = sources.filter(
        (s) =>
          s.rel.startsWith(path.join("apps", "api", "src")) &&
          s.rel !== CONSTANTS_FILE &&
          s.text.includes(`API_ERROR_CODES.${key}`),
      );
      expect(users.length).toBeGreaterThan(0);
    },
  );
});
