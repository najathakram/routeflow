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
  "apps/mobile/app/(customer)/orders/[id].tsx": [
    "CONCURRENT_UPDATE",
    "CHANGE_WINDOW_CLOSED",
    "EDIT_WINDOW_OPEN",
  ],
  "apps/mobile/app/(driver)/route/settlement.tsx": ["RUN_ALREADY_SETTLED"],
  "apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx": ["EMAIL_SEND_FAILED"],
  "apps/mobile/app/(operator)/statements/index.tsx": [
    "AI_KEY_INVALID",
    "AI_SCAN_REJECTED",
    "AI_UNAVAILABLE",
    "AI_PARSE_FAILED",
  ],
  "apps/mobile/components/NewOrderScreen.tsx": ["MERGE_CHOICE_REQUIRED"],
  "apps/mobile/lib/api/supplier-statements.ts": [
    "AI_KEY_INVALID",
    "AI_SCAN_REJECTED",
    "AI_UNAVAILABLE",
    "AI_PARSE_FAILED",
  ],
  "apps/mobile/lib/at-stop-cr-outcome.ts": ["CHANGE_REQUEST_ALREADY_RESOLVED"],
  "apps/mobile/lib/authorizations-logic.ts": ["REGULATED_AUTH_REQUIRED"],
  "apps/mobile/lib/credit-limit-error.ts": ["CREDIT_LIMIT_EXCEEDED"],
  "apps/mobile/lib/inline-return-submit-key.ts": [
    "INLINE_RETURN_ORDER_NOT_FOUND",
    "INLINE_RETURN_ORDER_CUSTOMER_MISMATCH",
    "INLINE_RETURN_ORDER_CANCELLED",
    "INLINE_RETURN_KEY_CONFLICT",
    "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS",
    "INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED",
  ],
  "apps/mobile/lib/queue-drain.ts": ["MERGE_IN_PROGRESS", "LOCK_UNAVAILABLE"],
  "apps/mobile/lib/selling-restricted.ts": ["SELLING_RESTRICTED"],
  "apps/mobile/lib/vendor-bill-scan.ts": ["MONEY_INVARIANT"],
  "apps/web/app/(dashboard)/_components/gates/PlanGateBoundary.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/compliance/[categoryId]/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/finance/commissions/[id]/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/finance/commissions/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/finance/statements/page.tsx": [
    "AI_KEY_INVALID",
    "AI_SCAN_REJECTED",
    "AI_UNAVAILABLE",
    "AI_PARSE_FAILED",
  ],
  "apps/web/app/(dashboard)/inventory/_components/purchase-orders-edit.ts": [
    "PO_LOT_PARTIALLY_CONSUMED",
  ],
  "apps/web/app/(dashboard)/invoices/[id]/page.tsx": ["EMAIL_NOT_CONFIGURED", "EMAIL_SEND_FAILED"],
  "apps/web/app/(dashboard)/invoices/new/page.tsx": ["REGULATED_AUTH_REQUIRED"],
  "apps/web/app/(dashboard)/orders/[id]/page.tsx": [
    "CHANGE_REQUEST_ALREADY_RESOLVED",
    "CHANGE_WINDOW_CLOSED",
    "LINE_ALREADY_DELIVERED",
    "STOP_ALREADY_COMPLETED",
  ],
  "apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx": ["MERGE_CHOICE_REQUIRED"],
  "apps/web/app/(dashboard)/sales-agents/[id]/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/sales-agents/page.tsx": ["PLAN_GATE"],
  "apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx": ["MONEY_INVARIANT"],
  "apps/web/app/(dashboard)/vendor-bills/page.tsx": ["MONEY_INVARIANT"],
  "apps/web/app/buyer/portal/[seller]/cart/page.tsx": ["REGULATED_AUTH_REQUIRED"],
  "apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx": [
    "CHANGE_WINDOW_CLOSED",
    "EDIT_WINDOW_OPEN",
    "REGULATED_AUTH_REQUIRED",
  ],
  "apps/web/components/ScanInvoiceModal.tsx": ["AI_KEY_INVALID"],
  "apps/web/lib/api/authorizations.ts": ["REGULATED_AUTH_REQUIRED"],
  "apps/web/lib/api/credit-limit.ts": ["CREDIT_LIMIT_EXCEEDED"],
  "apps/web/lib/api/restrictions-settings.ts": ["SELLING_RESTRICTIONS_NOT_READY"],
  "apps/web/lib/api/selling-restricted.ts": ["SELLING_RESTRICTED"],
  "apps/web/lib/api/supplier-statements.ts": [
    "AI_KEY_INVALID",
    "AI_SCAN_REJECTED",
    "AI_UNAVAILABLE",
    "AI_PARSE_FAILED",
  ],
  "apps/web/lib/mutation-error-toast.ts": [
    "CHANGE_REQUEST_ALREADY_RESOLVED",
    "CHANGE_WINDOW_CLOSED",
    "EDIT_WINDOW_OPEN",
    "LINE_ALREADY_DELIVERED",
    "CREDIT_LIMIT_EXCEEDED",
    "MERGE_CHOICE_REQUIRED",
    "STOP_ALREADY_COMPLETED",
    "SELLING_RESTRICTED",
    "SELLING_RESTRICTIONS_NOT_READY",
    "REGULATED_AUTH_REQUIRED",
  ],
  "apps/web/lib/plan-gate.ts": ["PLAN_GATE", "PLAN_GATE_UNAVAILABLE"],
  "apps/web/lib/po-bill-refusal.ts": ["BILL_EXCEEDS_PO"],
  "apps/web/lib/scan-po-lock.ts": ["PLAN_GATE"],
};
const CONSUMER_ALLOWLIST_TOTAL = 75;

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
  // web: tenant STATUS checks (`status !== "READ_ONLY"`), not the error code
  "apps/web/app/(dashboard)/settings/billing/page.tsx",
  "apps/web/components/ReadOnlyBanner.tsx",
];

/**
 * `SELLING_RESTRICTED` is ALSO a suspension REASON value (`reason: "SELLING_RESTRICTED"`, `suspendedReason: ...`) in recurring
 * invoices and order templates: data, not an error code. A bare literal in these two files is that reason; the 409 body (in
 * selling-restrictions.service.ts) goes through the constant, and neither file may spell it as a `code`.
 */
const SELLING_RESTRICTED_REASON_FILES = [
  "apps/api/src/recurring-invoices/recurring-invoices.service.ts",
  "apps/api/src/order-templates/order-templates.service.ts",
];

/**
 * `ONBOARDING_STEP_WAIVED` is ALSO an audit ACTION key (`ONBOARDING_STEP_WAIVED: "ONBOARDING_STEP_WAIVED"`) in the audit-actions
 * constant: data, not an error code. The 409 body (in onboarding.service.ts) goes through the constant, and the audit file may
 * not spell it as a `code`.
 */
const ONBOARDING_STEP_WAIVED_AUDIT_FILES = [
  "apps/api/src/platform-admin/audit-actions.constant.ts",
];

/** A READ_ONLY literal used as an error CODE: a property (`code: "READ_ONLY"`) or a comparison (`code === "READ_ONLY"`, `!==`, `==`). */
const READ_ONLY_CODE_LITERAL = /\bcode\b\s*(?::|[!=]==?)\s*["'`]READ_ONLY/;

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
        .filter((rel) => !(key === "READ_ONLY" && READ_ONLY_STATUS_FILES.includes(rel)))
        .filter(
          (rel) => !(key === "SELLING_RESTRICTED" && SELLING_RESTRICTED_REASON_FILES.includes(rel)),
        )
        .filter(
          (rel) =>
            !(key === "ONBOARDING_STEP_WAIVED" && ONBOARDING_STEP_WAIVED_AUDIT_FILES.includes(rel)),
        );
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

  it("mutation-proof: the READ_ONLY code-literal pattern catches a property and every comparison form, not the status word", () => {
    for (const planted of [
      'code: "READ_ONLY"',
      "code:'READ_ONLY'",
      'data?.code === "READ_ONLY"',
      "body.code !== 'READ_ONLY'",
      'err.code == "READ_ONLY"',
    ])
      expect(planted).toMatch(READ_ONLY_CODE_LITERAL);
    for (const status of [
      'status === "READ_ONLY"',
      's.status !== "READ_ONLY"',
      'where: { status: "READ_ONLY" }',
    ])
      expect(status).not.toMatch(READ_ONLY_CODE_LITERAL);
  });

  it("SELLING_RESTRICTED: the reason files really spell it as a reason, never as an error `code`, and the 409 body goes through the constant", () => {
    // A property (`code: "X"`, quoted key `"code": "X"`), a comparison (`code === "X"`) or the reversed comparison (`"X" === body.code`).
    const codeLiteral =
      /\bcode["'`]?\s*(?::|[!=]==?)\s*["'`]SELLING_RESTRICTED|["'`]SELLING_RESTRICTED["'`]\s*[!=]==?\s*[\w$.?[\]"'`]*\bcode\b/;
    for (const rel of SELLING_RESTRICTED_REASON_FILES) {
      const src = sources.find((s) => posix(s.rel) === rel);
      expect(src?.text).toMatch(/["'`]SELLING_RESTRICTED["'`]/);
      expect(src?.text).not.toMatch(codeLiteral);
    }
    expect(codeLiteral.test('code: "SELLING_RESTRICTED"')).toBe(true);
    expect(codeLiteral.test("body.code === 'SELLING_RESTRICTED'")).toBe(true);
    expect(codeLiteral.test('{ "code": "SELLING_RESTRICTED" }')).toBe(true);
    expect(codeLiteral.test('"SELLING_RESTRICTED" === code')).toBe(true);
    expect(codeLiteral.test("'SELLING_RESTRICTED' !== err.response?.data?.code")).toBe(true);
    expect(codeLiteral.test('reason: "SELLING_RESTRICTED"')).toBe(false);
    expect(codeLiteral.test('reason === "SELLING_RESTRICTED"')).toBe(false);
    expect(codeLiteral.test('"SELLING_RESTRICTED" === suspendedReason')).toBe(false);
    const svc = sources.find(
      (s) => posix(s.rel) === "apps/api/src/selling-restrictions/selling-restrictions.service.ts",
    );
    expect(svc?.text).toContain("code: API_ERROR_CODES.SELLING_RESTRICTED");
  });

  it("ONBOARDING_STEP_WAIVED: the audit file really spells it as an audit action, never as an error `code`, and the 409 body goes through the constant", () => {
    const codeLiteral =
      /\bcode["'`]?\s*(?::|[!=]==?)\s*["'`]ONBOARDING_STEP_WAIVED|["'`]ONBOARDING_STEP_WAIVED["'`]\s*[!=]==?\s*[\w$.?[\]"'`]*\bcode\b/;
    for (const rel of ONBOARDING_STEP_WAIVED_AUDIT_FILES) {
      const src = sources.find((s) => posix(s.rel) === rel);
      expect(src?.text).toMatch(/ONBOARDING_STEP_WAIVED:\s*["'`]ONBOARDING_STEP_WAIVED["'`]/);
      expect(src?.text).not.toMatch(codeLiteral);
    }
    expect(codeLiteral.test('code: "ONBOARDING_STEP_WAIVED"')).toBe(true);
    expect(codeLiteral.test("body.code === 'ONBOARDING_STEP_WAIVED'")).toBe(true);
    expect(codeLiteral.test('ONBOARDING_STEP_WAIVED: "ONBOARDING_STEP_WAIVED"')).toBe(false);
    expect(codeLiteral.test('action: "ONBOARDING_STEP_WAIVED"')).toBe(false);
    const svc = sources.find(
      (s) => posix(s.rel) === "apps/api/src/onboarding/onboarding.service.ts",
    );
    expect(svc?.text).toContain("code: API_ERROR_CODES.ONBOARDING_STEP_WAIVED");
  });

  it("READ_ONLY: the status files really spell the status, and the guard's 403 body goes through the constant", () => {
    for (const rel of READ_ONLY_STATUS_FILES) {
      const src = sources.find((s) => posix(s.rel) === rel);
      expect(src?.text).toMatch(/["'`]READ_ONLY["'`]/);
      // The exemption is for the STATUS word only: a `code: "READ_ONLY"` or a `code === "READ_ONLY"` comparison in an exempt
      // file is an error-code literal.
      expect(src?.text).not.toMatch(READ_ONLY_CODE_LITERAL);
    }
    const guard = sources.find(
      (s) => posix(s.rel) === "apps/api/src/tenant/tenant-status.guard.ts",
    );
    expect(guard?.text).toContain("code: API_ERROR_CODES.READ_ONLY");
  });
});

describe("API error codes: the onboarding contracts are registered (B987-C)", () => {
  // The three onboarding contract lists are pinned against the service sources by their own specs; those specs accept the
  // constant form, so this pin makes sure every listed code IS registered here (value == key), in both directions of drift.
  it("every INTAKE / ONBOARDING / TENANT_ONBOARDING contract code is an API_ERROR_CODES key with value == key", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as Record<string, readonly string[]>;
    const lists = [
      shared.INTAKE_ERROR_CODES,
      shared.ONBOARDING_CONFLICT_CODES,
      shared.TENANT_ONBOARDING_CONFLICT_CODES,
    ];
    for (const list of lists) {
      expect(Array.isArray(list) && list.length > 0).toBe(true);
      for (const code of list) expect((API_LOCAL as Record<string, string>)[code]).toBe(code);
    }
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
