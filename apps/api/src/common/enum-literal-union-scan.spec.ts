import * as fs from "fs";
import * as path from "path";

/**
 * B1059 / L-072 class guard: a hand-typed string-literal union whose member set EXACTLY equals a
 * shared Prisma-enum `X_VALUES` array (>= 3 members) is a local mirror that drifts silently. Use
 * the shared type from `@routeflow/types` (packages/types/api/enums.ts) instead.
 *
 * enum-parity.spec.ts pins the `X_VALUES` arrays to Prisma; this spec pins that nobody re-types
 * them. Scope: apps/web, apps/api/src, packages/* except packages/types, apps/mobile. A deliberate
 * SUBSET (fewer members) is not a mirror and is not flagged.
 *
 * BASELINE is shrink-only and counted per file::ENUM key: an entry that no longer matches fails,
 * and a second copy of an already-listed enum in the same file fails. List a key twice to tolerate
 * two copies. Known gaps: a union with null/a comment mid-list and single-quoted unions are missed.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const MIN_MEMBERS = 3;

export function parseEnumValueSets(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /export const (\w+_VALUES)\s*=\s*\[([^\]]*)\]\s*as const/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const members = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    if (members.length >= MIN_MEMBERS) out.set(m[1], new Set(members));
  }
  return out;
}

/** Every string-literal union (2+ members) in `src`, as its member set. */
export function findLiteralUnions(src: string): Set<string>[] {
  const out: Set<string>[] = [];
  const re = /"[^"\n]+"(?:\s*\|\s*"[^"\n]+")+/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out.push(new Set([...m[0].matchAll(/"([^"\n]+)"/g)].map((x) => x[1])));
  }
  return out;
}

export function findMirrors(src: string, enums: Map<string, Set<string>>): string[] {
  const hits: string[] = [];
  for (const u of findLiteralUnions(src)) {
    for (const [name, set] of enums) {
      if (u.size === set.size && [...u].every((v) => set.has(v))) hits.push(name);
    }
  }
  return hits;
}

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", ".expo", "coverage"]);
function walk(dir: string, acc: string[]): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), acc);
    } else if (/\.tsx?$/.test(e.name) && !/((\.d)|(\.(spec|test)))\.tsx?$/.test(e.name)) {
      // Test files are skipped: their literal fixtures are not shipped types.
      acc.push(path.join(dir, e.name));
    }
  }
  return acc;
}

function scanRoots(): string[] {
  const roots = [
    path.join(ROOT, "apps/web"),
    path.join(ROOT, "apps/api/src"),
    path.join(ROOT, "apps/mobile"),
  ];
  for (const p of fs.readdirSync(path.join(ROOT, "packages"))) {
    if (p !== "types") roots.push(path.join(ROOT, "packages", p));
  }
  return roots;
}

/**
 * Shrink-only. "<repo-relative file>::<ENUM_VALUES name>".
 * apps/mobile is frozen native (no edits); the rest are listed with the reason.
 */
const BASELINE: string[] = [
  // apps/mobile: frozen native, no edits allowed.
  "apps/mobile/components/MapView.tsx::ROUTE_RUN_STOP_STATUS_VALUES",
  "apps/mobile/lib/api/admin.ts::FULFILL_PATH_VALUES",
  "apps/mobile/lib/api/admin.ts::ROUTE_RUN_STATUS_VALUES",
  "apps/mobile/lib/api/admin.ts::USER_STATUS_VALUES",
  "apps/mobile/lib/api/expenses.ts::EXPENSE_STATUS_VALUES",
  "apps/mobile/lib/api/inventory.ts::MOVEMENT_TYPE_VALUES",
  "apps/mobile/lib/api/invoices.ts::INVOICE_STATUS_VALUES",
  "apps/mobile/lib/api/orders.ts::FULFILL_PATH_VALUES",
  "apps/mobile/lib/api/orders.ts::FULFILL_PATH_VALUES",
  "apps/mobile/lib/api/orders.ts::ORDER_STATUS_VALUES",
  "apps/mobile/lib/api/payments.ts::CHECK_STATUS_VALUES",
  "apps/mobile/lib/api/recurring-invoices.ts::RECURRING_FREQUENCY_VALUES",
  "apps/mobile/lib/api/returns.ts::RETURN_REASON_VALUES",
  "apps/mobile/lib/api/returns.ts::RETURN_STATUS_VALUES",
  "apps/mobile/lib/api/routes.ts::ROUTE_END_KIND_VALUES",
  "apps/mobile/lib/api/routes.ts::ROUTE_RUN_STATUS_VALUES",
  "apps/mobile/lib/api/routes.ts::ROUTE_RUN_STOP_STATUS_VALUES",
  "apps/mobile/lib/api/supplier-statements.ts::SUPPLIER_STATEMENT_SCAN_STATUS_VALUES",
  "apps/mobile/lib/api/tracked-categories.ts::INVOICE_TREATMENT_VALUES",
  "apps/mobile/lib/api/tracked-categories.ts::REPORT_CADENCE_VALUES",
  "apps/mobile/lib/api/tracked-categories.ts::TRACKED_CATEGORY_TAX_TYPE_VALUES",
  "apps/mobile/lib/api/vendor-bills.ts::INVOICE_SCAN_STATUS_VALUES",
  "apps/mobile/lib/auth.ts::USER_STATUS_VALUES",
  "apps/mobile/lib/authorizations-logic.ts::AUTHORIZATION_STATUS_VALUES",
  "apps/mobile/lib/buyer-licenses-logic.ts::AUTHORIZATION_STATUS_VALUES",
  "apps/mobile/lib/check-badge.ts::CHECK_STATUS_VALUES",
  "apps/mobile/lib/customer-authorizations-logic.ts::AUTHORIZATION_STATUS_VALUES",
  "apps/mobile/lib/edit-items-draft.ts::PRODUCT_KIND_VALUES",
  "apps/mobile/lib/order-actions.ts::FULFILL_PATH_VALUES",
  "apps/mobile/lib/stock-count-logic.ts::STOCK_COUNT_STATUS_VALUES",
  "apps/mobile/lib/user-admin.ts::USER_STATUS_VALUES",
  // apps/web: other enums, each its own follow-up fold (not the B1059 FulfillPath mirror).
  "apps/web/app/(dashboard)/dispatch/page.tsx::ROUTE_RUN_STATUS_VALUES",
  "apps/web/app/(dashboard)/inventory/_components/purchase-orders-shared.ts::PURCHASE_ORDER_STATUS_VALUES",
  "apps/web/app/(dashboard)/invoices/recurring/_components/RecurringInvoiceForm.tsx::RECURRING_FREQUENCY_VALUES",
  "apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx::ROUTE_RUN_STATUS_VALUES",
  "apps/web/app/(dashboard)/routes/my-runs/page.tsx::ROUTE_RUN_STATUS_VALUES",
  "apps/web/app/(dashboard)/routes/page.tsx::ROUTE_RUN_STATUS_VALUES",
  "apps/web/app/(dashboard)/settings/_components/GoHighLevelSettingsTab.tsx::CRM_CONNECTION_STATUS_VALUES",
  "apps/web/app/(platform-admin)/admin/buyers/[id]/page.tsx::BUYER_ACCOUNT_STATUS_VALUES",
  "apps/web/app/(platform-admin)/admin/buyers/[id]/page.tsx::BUYER_ACCOUNT_STATUS_VALUES",
  "apps/web/app/(platform-admin)/admin/buyers/page.tsx::BUYER_ACCOUNT_STATUS_VALUES",
  "apps/web/app/(platform-admin)/admin/buyers/page.tsx::BUYER_ACCOUNT_STATUS_VALUES",
  "apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx::CHANGE_REQUEST_TYPE_VALUES",
  "apps/web/components/RoutePlanningControls.tsx::ROUTE_END_KIND_VALUES",
  "apps/web/components/RoutePlanningControls.tsx::ROUTE_ORIGIN_KIND_VALUES",
  "apps/web/lib/api/authorizations.ts::AUTHORIZATION_STATUS_VALUES",
  "apps/web/lib/api/batch-import.ts::IMPORT_BATCH_STATUS_VALUES",
  "apps/web/lib/api/batch-import.ts::IMPORT_FILE_STATUS_VALUES",
  "apps/web/lib/api/finance.ts::EXPENSE_STATUS_VALUES",
  "apps/web/lib/api/finance.ts::EXPENSE_STATUS_VALUES",
  "apps/web/lib/api/invoices.ts::CHECK_STATUS_VALUES",
  "apps/web/lib/api/migration.ts::MIGRATION_JOB_STATUS_VALUES",
  "apps/web/lib/api/migration.ts::MIGRATION_SOURCE_VALUES",
  "apps/web/lib/api/products.ts::COSTING_METHOD_VALUES",
  "apps/web/lib/api/promotions.ts::PROMOTION_SCOPE_VALUES",
  "apps/web/lib/api/promotions.ts::PROMOTION_TYPE_VALUES",
  "apps/web/lib/api/returns.ts::RETURN_REASON_VALUES",
  "apps/web/lib/api/returns.ts::RETURN_STATUS_VALUES",
  "apps/web/lib/api/routes.ts::ROUTE_END_KIND_VALUES",
  "apps/web/lib/api/routes.ts::ROUTE_END_KIND_VALUES",
  "apps/web/lib/api/routes.ts::ROUTE_ORIGIN_KIND_VALUES",
  "apps/web/lib/api/routes.ts::ROUTE_RUN_STATUS_VALUES",
  "apps/web/lib/api/routes.ts::ROUTE_RUN_STOP_STATUS_VALUES",
  "apps/web/lib/api/routes.ts::ROUTE_RUN_STOP_STATUS_VALUES",
  "apps/web/lib/api/sales-agents.ts::COMMISSION_ACCRUAL_STATUS_VALUES",
  "apps/web/lib/api/sales-agents.ts::COMMISSION_RATE_SOURCE_VALUES",
  "apps/web/lib/api/sales-agents.ts::COMMISSION_STATEMENT_LINE_KIND_VALUES",
  "apps/web/lib/api/sales-agents.ts::COMMISSION_STATEMENT_STATUS_VALUES",
  "apps/web/lib/api/sales-agents.ts::SALES_AGENT_STATUS_VALUES",
  "apps/web/lib/api/stock-count.ts::STOCK_COUNT_STATUS_VALUES",
  "apps/web/lib/api/supplier-statements.ts::SUPPLIER_STATEMENT_SCAN_STATUS_VALUES",
  "apps/web/lib/api/tracked-categories.ts::INVOICE_TREATMENT_VALUES",
  "apps/web/lib/api/tracked-categories.ts::REPORT_CADENCE_VALUES",
  "apps/web/lib/api/tracked-categories.ts::TRACKED_CATEGORY_TAX_TYPE_VALUES",
  "apps/web/lib/api/users.ts::USER_STATUS_VALUES",
  "apps/web/lib/api/users.ts::USER_STATUS_VALUES",
  "apps/web/lib/api/vendor-bills.ts::INVOICE_SCAN_STATUS_VALUES",
  "apps/web/lib/auth.ts::USER_STATUS_VALUES",
  "apps/web/lib/check-badge.ts::CHECK_STATUS_VALUES",
  // apps/api + packages/pricing: server-side/runtime-package copies (api and pricing cannot runtime-import the raw-TS types package); fold by deriving from Prisma / enums.ts types.
  "apps/api/src/authorizations/authorizations.service.ts::AUTHORIZATION_STATUS_VALUES",
  "apps/api/src/billing/plan-catalog.constants.ts::TENANT_PLAN_VALUES",
  "apps/api/src/bookkeeping/bookkeeping.controller.ts::EXPENSE_STATUS_VALUES",
  "apps/api/src/bookkeeping/bookkeeping.service.ts::EXPENSE_STATUS_VALUES",
  "apps/api/src/bookkeeping/dto/create-expense.dto.ts::EXPENSE_STATUS_VALUES",
  "apps/api/src/buyer/buyer-admin.controller.ts::BUYER_ACCOUNT_STATUS_VALUES",
  "apps/api/src/buyer/buyer-admin.service.ts::BUYER_ACCOUNT_STATUS_VALUES",
  "apps/api/src/email/mailbox/mailbox-connection.service.ts::MAILBOX_CONNECTION_STATUS_VALUES",
  "apps/api/src/email/mailbox/mailbox-connection.service.ts::MAILBOX_CONNECTION_STATUS_VALUES",
  "apps/api/src/import/batch-import.service.ts::IMPORT_BATCH_STATUS_VALUES",
  "apps/api/src/inventory/dto/stock-count-session.dto.ts::STOCK_COUNT_STATUS_VALUES",
  "apps/api/src/inventory/stock-count-commit.ts::STOCK_COUNT_STATUS_VALUES",
  "apps/api/src/invoices/to-collect.ts::TO_COLLECT_STATE_VALUES",
  "apps/api/src/products/recipes.service.ts::RECIPE_STATUS_VALUES",
  "apps/api/src/regulated/dto/prepare-filing.dto.ts::REPORT_CADENCE_VALUES",
  "apps/api/src/regulated/period.ts::REPORT_CADENCE_VALUES",
  "apps/api/src/returns/inline-returns-pricing.ts::RETURN_PRICE_SOURCE_VALUES",
  "apps/api/src/sales-agents/commission-math.ts::COMMISSION_RATE_SOURCE_VALUES",
  "apps/api/src/sales-agents/commission-statements.service.ts::COMMISSION_STATEMENT_LINE_KIND_VALUES",
  "apps/api/src/settings-fulfilment/testing/fulfilment-world.ts::FULFILL_PATH_VALUES",
  "packages/pricing/src/golden.fixtures.ts::PROMOTION_SCOPE_VALUES",
  "packages/pricing/src/golden.fixtures.ts::PROMOTION_TYPE_VALUES",
  "packages/pricing/src/price-authority.ts::PRODUCT_KIND_VALUES",
  "packages/pricing/src/pricing.ts::PROMOTION_SCOPE_VALUES",
  "packages/pricing/src/pricing.ts::PROMOTION_TYPE_VALUES",
  "packages/pricing/src/pricing.ts::TRACKED_CATEGORY_TAX_TYPE_VALUES",
];

/** Copies per `file::ENUM` key; a key listed N times in BASELINE tolerates N copies. */
export function countKeys(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/** More copies than the baseline allows = unexpected; fewer = stale (shrink-only both ways). */
export function diffCounts(
  found: Map<string, number>,
  base: Map<string, number>,
): { unexpected: string[]; stale: string[] } {
  const unexpected: string[] = [];
  const stale: string[] = [];
  for (const k of new Set([...found.keys(), ...base.keys()])) {
    const f = found.get(k) ?? 0;
    const b = base.get(k) ?? 0;
    for (let i = b; i < f; i++) unexpected.push(k);
    for (let i = f; i < b; i++) stale.push(k);
  }
  return { unexpected: unexpected.sort(), stale: stale.sort() };
}

describe("enum-literal-union scan (B1059, L-072)", () => {
  const enums = parseEnumValueSets(
    fs.readFileSync(path.join(ROOT, "packages/types/api/enums.ts"), "utf8"),
  );

  describe("detector self-test", () => {
    const fixture = new Map([["FULFILL_PATH_VALUES", new Set(["ROUTE", "SHIP", "PICKUP"])]]);
    it("flags an exact copy (any order, multi-line, with null)", () => {
      expect(findMirrors('type A = "PICKUP" | "ROUTE" | "SHIP" | null;', fixture)).toEqual([
        "FULFILL_PATH_VALUES",
      ]);
      expect(findMirrors('type A =\n  | "ROUTE"\n  | "SHIP"\n  | "PICKUP";', fixture)).toHaveLength(
        1,
      );
    });
    it("does not flag a subset or a superset", () => {
      expect(findMirrors('type A = "ROUTE" | "SHIP";', fixture)).toEqual([]);
      expect(findMirrors('type A = "ROUTE" | "SHIP" | "PICKUP" | "X";', fixture)).toEqual([]);
    });
    it("does not flag a 2-member enum", () => {
      const two = new Map([["T_VALUES", new Set(["A", "B"])]]);
      expect(parseEnumValueSets('export const T_VALUES = ["A", "B"] as const;').size).toBe(0);
      expect(findMirrors('type A = "A" | "B";', two)).toHaveLength(1); // guarded by the parse floor
    });
    it("counts copies per key: a second copy in a listed file goes red, a removed one is stale", () => {
      const base = countKeys(["f.ts::X_VALUES"]);
      expect(diffCounts(countKeys(["f.ts::X_VALUES", "f.ts::X_VALUES"]), base)).toEqual({
        unexpected: ["f.ts::X_VALUES"],
        stale: [],
      });
      expect(diffCounts(countKeys([]), base)).toEqual({
        unexpected: [],
        stale: ["f.ts::X_VALUES"],
      });
      expect(diffCounts(countKeys(["f.ts::X_VALUES"]), base)).toEqual({
        unexpected: [],
        stale: [],
      });
    });
    it("parses X_VALUES arrays", () => {
      expect(
        parseEnumValueSets('export const X_VALUES = ["A", "B", "C"] as const;').get("X_VALUES"),
      ).toEqual(new Set(["A", "B", "C"]));
    });
  });

  it("parses a plausible number of shared enums", () => {
    expect(enums.size).toBeGreaterThan(50);
    expect(enums.has("FULFILL_PATH_VALUES")).toBe(true);
  });

  it("no hand-typed literal union mirrors a shared enum outside packages/types (shrink-only baseline)", () => {
    const found = new Map<string, number>();
    for (const root of scanRoots()) {
      for (const file of walk(root, [])) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        for (const name of findMirrors(fs.readFileSync(file, "utf8"), enums)) {
          found.set(`${rel}::${name}`, (found.get(`${rel}::${name}`) ?? 0) + 1);
        }
      }
    }
    const { unexpected, stale } = diffCounts(found, countKeys(BASELINE));
    expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
  });
});
