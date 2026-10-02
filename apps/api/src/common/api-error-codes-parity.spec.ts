import * as fs from "fs";
import * as path from "path";
import {
  API_ERROR_CODES as API_LOCAL,
  PLAN_GATE_FLAG_KEYS as FLAG_KEYS_LOCAL,
} from "./api-error-codes";

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

  it("PLAN_GATE_FLAG_KEYS (a gate `flag`, not an error code) equals the shared one", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = (require("@routeflow/types") as Record<string, unknown>).PLAN_GATE_FLAG_KEYS;
    expect(FLAG_KEYS_LOCAL).toEqual(shared);
    expect(FLAG_KEYS_LOCAL.METER_CUSTOMERS).toBe("meter.customers");
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
      // `rel` uses the platform separator (\ on win32): compare against the same form.
      const platformRoot = path.join(...root.split("/"));
      expect(sources.some((s) => s.rel.startsWith(platformRoot))).toBe(true);
    }
  });
});

/**
 * B982: the web / mobile files that still spell a code as a bare literal. SHRINK-ONLY: the web PR that
 * switches those consumers to the constants deletes entries; an entry whose file no longer spells the
 * code fails (delete it), and the total is pinned. The API has no entries: every API throw site uses
 * the constant. Posix-style paths.
 */
const CONSUMER_ALLOWLIST: Record<string, string[]> = {
  "apps/mobile/app/(customer)/orders/[id].tsx": ["CONCURRENT_UPDATE"],
  "apps/mobile/lib/inline-return-submit-key.ts": [
    "INLINE_RETURN_ORDER_NOT_FOUND",
    "INLINE_RETURN_ORDER_CUSTOMER_MISMATCH",
    "INLINE_RETURN_ORDER_CANCELLED",
    "INLINE_RETURN_KEY_CONFLICT",
    "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS",
    "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
  ],
  "apps/mobile/lib/queue-drain.ts": ["MERGE_IN_PROGRESS", "LOCK_UNAVAILABLE"],
  "apps/web/app/(dashboard)/_components/gates/PlanGateBoundary.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/finance/commissions/[id]/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/finance/commissions/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/sales-agents/[id]/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/sales-agents/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/settings/billing/page.tsx": ["READ_ONLY"],
  "apps/web/components/ReadOnlyBanner.tsx": ["READ_ONLY"],
  "apps/web/lib/mutation-error-toast.ts": ["READ_ONLY"],
  "apps/web/lib/plan-gate.ts": ["PLAN_GATE", "PLAN_GATE_UNAVAILABLE"],
  "apps/web/lib/po-bill-refusal.ts": ["BILL_EXCEEDS_PO"],
  "apps/web/lib/scan-po-lock.ts": ["PLAN_GATE"],
};
const CONSUMER_ALLOWLIST_TOTAL = 22;

/**
 * `READ_ONLY` is ALSO a tenant STATUS value (`tenant.status === "READ_ONLY"`), which is not an error
 * code, so a bare `"READ_ONLY"` in these API files is the status. The one error-code use (the guard's
 * 403 body) must still go through the constant (pinned below).
 */
const READ_ONLY_STATUS_FILES = [
  "apps/api/src/billing/billing-cron.service.ts",
  "apps/api/src/billing/billing.service.ts",
  "apps/api/src/billing/mrr.service.ts",
  "apps/api/src/billing/subscription-mutation.service.ts",
  "apps/api/src/tenant/tenant-status.guard.ts",
];

const posix = (rel: string) => rel.split(path.sep).join("/");

describe("API error codes: no bare string literal in production source (#2163)", () => {
  it.each(Object.entries(API_LOCAL))(
    "%s (%s) is only ever spelled in the constants module",
    (key, code) => {
      const literal = new RegExp(`["'\`]${code}["'\`]`);
      const offenders = sources
        .filter((s) => s.rel !== CONSTANTS_FILE && literal.test(s.text))
        .map((s) => posix(s.rel))
        .filter((rel) => !(CONSUMER_ALLOWLIST[rel] ?? []).includes(code))
        .filter((rel) => !(key === "READ_ONLY" && READ_ONLY_STATUS_FILES.includes(rel)));
      expect(offenders).toEqual([]);
    },
  );

  it("every consumer allowlist entry is still a real literal use (shrink-only), and the total is pinned", () => {
    let total = 0;
    for (const [rel, codes] of Object.entries(CONSUMER_ALLOWLIST)) {
      const src = sources.find((s) => posix(s.rel) === rel);
      expect(src).toBeDefined();
      for (const code of codes) {
        total += 1;
        expect(new RegExp(`["'\`]${code}["'\`]`).test(src?.text ?? "")).toBe(true);
      }
    }
    expect(total).toBe(CONSUMER_ALLOWLIST_TOTAL);
  });

  it("READ_ONLY: the status files really spell the status, and the guard's 403 body goes through the constant", () => {
    for (const rel of READ_ONLY_STATUS_FILES) {
      const src = sources.find((s) => posix(s.rel) === rel);
      expect(src?.text).toMatch(/["'`]READ_ONLY["'`]/);
    }
    const guard = sources.find(
      (s) => posix(s.rel) === "apps/api/src/tenant/tenant-status.guard.ts",
    );
    expect(guard?.text).toContain("code: API_ERROR_CODES.READ_ONLY");
  });
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
