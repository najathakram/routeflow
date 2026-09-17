import * as fs from "fs";
import * as path from "path";
import * as PrismaEnums from "@prisma/client";
import {
  PLAN_KEYS as API_PLAN_KEYS,
  FLAG_KEYS as API_FLAG_KEYS,
} from "../billing/plan-catalog.constants";

/**
 * Guards the class of bug found by the Wave E DTO sweep (imp-10b): web and
 * mobile hand-type a client-side string union for every Prisma enum they
 * mirror, and those unions drift silently — a value invented (mobile
 * `VendorBillStatus` had `"FULL"`, which has never existed), a value renamed
 * (mobile `POStatus` had `"PARTIALLY_RECEIVED"` where the schema says
 * `PARTIAL`), a value omitted (mobile `BuyerPromotion.type` lacked
 * `"BUY_N_GET_M"`; both apps' `VendorBillStatus` omitted `OVERDUE`; both
 * apps' `EstimateStatus` invented a phantom `"EXPIRED"`).
 *
 * Fix: one const-array union per Prisma enum lives in
 * `packages/types/api/enums.ts`; both apps import it instead of hand-typing
 * their own. This spec has two layers:
 *
 * 1. A generic parity table — every shared array in `packages/types/api/enums.ts`
 *    must be set-equal to the corresponding `@prisma/client` enum's `Object.values()`.
 *    The import is guarded (never `require` at module scope unguarded) so a
 *    missing export fails on its OWN value (an empty actual array diffed
 *    against the real Prisma values), not a hard "Cannot find module" crash
 *    that kills every case in the file at once.
 * 2. A regression layer that reads the actual CURRENT source text of the
 *    specific web/mobile files that drifted and asserts they no longer
 *    hand-declare a conflicting literal union — this is what fails TODAY,
 *    before the fix, showing the real wrong values.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readSharedEnums(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@routeflow/types") as Record<string, unknown>;
  } catch {
    return {};
  }
}

const SHARED = readSharedEnums();

/** [array export name in packages/types/api/enums.ts, key on @prisma/client's enum namespace] */
const ENUM_TABLE: Array<[string, keyof typeof PrismaEnums]> = [
  ["ESTIMATE_STATUS_VALUES", "EstimateStatus"],
  ["EXPENSE_STATUS_VALUES", "ExpenseStatus"],
  ["INVOICE_STATUS_VALUES", "InvoiceStatus"],
  ["RETURN_STATUS_VALUES", "ReturnStatus"],
  ["RETURN_REASON_VALUES", "ReturnReason"],
  ["RETURN_KIND_VALUES", "ReturnKind"],
  ["CREDIT_NOTE_STATUS_VALUES", "CreditNoteStatus"],
  ["REGULATED_FILING_STATUS_VALUES", "RegulatedFilingStatus"],
  ["INVOICE_TREATMENT_VALUES", "InvoiceTreatment"],
  ["REPORT_CADENCE_VALUES", "ReportCadence"],
  ["TRACKED_CATEGORY_TAX_TYPE_VALUES", "TrackedCategoryTaxType"],
  ["INVOICE_SCAN_STATUS_VALUES", "InvoiceScanStatus"],
  ["SUPPLIER_STATEMENT_SCAN_STATUS_VALUES", "SupplierStatementScanStatus"],
  ["VENDOR_BILL_STATUS_VALUES", "VendorBillStatus"],
  ["PURCHASE_ORDER_STATUS_VALUES", "PurchaseOrderStatus"],
  ["PAYMENT_STATUS_VALUES", "PaymentStatus"],
  ["PRICE_TYPE_VALUES", "PriceType"],
  ["CHECK_STATUS_VALUES", "CheckStatus"],
  ["DOCUMENT_NUMBER_TYPE_VALUES", "DocumentNumberType"],
  ["COSTING_METHOD_VALUES", "CostingMethod"],
  ["AUTHORIZATION_STATUS_VALUES", "AuthorizationStatus"],
  ["AUTHORIZATION_SOURCE_VALUES", "AuthorizationSource"],
  ["PROMOTION_TYPE_VALUES", "PromotionType"],
  ["PROMOTION_SCOPE_VALUES", "PromotionScope"],
  ["MIGRATION_SOURCE_VALUES", "MigrationSource"],
  ["MIGRATION_JOB_STATUS_VALUES", "MigrationJobStatus"],
  ["STOCK_COUNT_STATUS_VALUES", "StockCountStatus"],
  ["SALES_AGENT_STATUS_VALUES", "SalesAgentStatus"],
  ["COMMISSION_RATE_SOURCE_VALUES", "CommissionRateSource"],
  ["COMMISSION_ACCRUAL_STATUS_VALUES", "CommissionAccrualStatus"],
  ["COMMISSION_STATEMENT_STATUS_VALUES", "CommissionStatementStatus"],
  ["COMMISSION_STATEMENT_LINE_KIND_VALUES", "CommissionStatementLineKind"],
  ["IMPORT_FILE_STATUS_VALUES", "ImportFileStatus"],
  ["IMPORT_BATCH_STATUS_VALUES", "ImportBatchStatus"],
  ["ROUTE_ORIGIN_KIND_VALUES", "RouteOriginKind"],
  ["ROUTE_END_KIND_VALUES", "RouteEndKind"],
  ["ROUTE_OPTIMIZE_METRIC_VALUES", "RouteOptimizeMetric"],
  ["CHANGE_REQUEST_TYPE_VALUES", "ChangeRequestType"],
  ["CHANGE_REQUEST_STATUS_VALUES", "ChangeRequestStatus"],
  ["RECURRING_FREQUENCY_VALUES", "RecurringFrequency"],
  ["MOVEMENT_TYPE_VALUES", "MovementType"],
  ["CRM_CONNECTION_STATUS_VALUES", "CrmConnectionStatus"],
  ["CRM_TRIGGER_MODE_VALUES", "CrmTriggerMode"],
  ["MAILBOX_PROVIDER_VALUES", "MailboxProvider"],
  ["MAILBOX_CONNECTION_STATUS_VALUES", "MailboxConnectionStatus"],
  ["CRM_HANDOFF_STATUS_VALUES", "CrmHandoffStatus"],
  ["TENANT_CLASS_VALUES", "TenantClass"],
  // Post-dated check payments PR-1 (2026-09-15): CheckReturnReason is a brand-new Prisma enum
  // (not a value added to an existing one) — see the triage tripwire below.
  ["CHECK_RETURN_REASON_VALUES", "CheckReturnReason"],
  // Feature grants PR-1 (2026-09-16): FeatureOverrideEffect is a brand-new Prisma enum — see
  // the triage tripwire below.
  ["FEATURE_OVERRIDE_EFFECT_VALUES", "FeatureOverrideEffect"],
  // Public demo booking (2026-09-16): another brand-new Prisma enum, mirrored so the marketing
  // site's demo-booking client derives its status type instead of hand-typing a union.
  ["DEMO_BOOKING_STATUS_VALUES", "DemoBookingStatus"],
];

describe("enum parity: packages/types/api/enums.ts vs @prisma/client", () => {
  it.each(ENUM_TABLE)("%s matches Object.values(PrismaClient.%s)", (arrayExportName, prismaKey) => {
    const actual = Array.isArray((SHARED as Record<string, unknown>)[arrayExportName])
      ? ((SHARED as Record<string, unknown>)[arrayExportName] as unknown[])
      : [];
    const prismaEnum = PrismaEnums[prismaKey] as Record<string, string> | undefined;
    const expected = prismaEnum ? Object.values(prismaEnum) : [];
    expect(new Set(actual)).toEqual(new Set(expected));
    expect(expected.length).toBeGreaterThan(0); // guard against a bad table row silently vacuous-passing
  });
});

// ─── Triage tripwire: no generated enum arrives unnoticed (L-072) ──────────────────────────────

/**
 * `ENUM_TABLE` above is a deliberate SUBSET — the enums `packages/types/api/enums.ts`
 * actually mirrors, 40 of the 80 the client generates today. Asserting the two sets EQUAL
 * would therefore be wrong: most Prisma enums have no client-side mirror and need none.
 *
 * What still has to be caught is a NEW enum arriving unnoticed, because the next thing that
 * happens to a new enum is web or mobile hand-typing it — the exact L-072 drift class this
 * file exists for. So pin the count instead. When this test fails, do the triage first:
 *   - enum ADDED → either add its `*_VALUES` array to `packages/types/api/enums.ts` plus a row
 *     to `ENUM_TABLE`, or decide deliberately that no app mirrors it — then bump the constant;
 *   - enum REMOVED → drop its `ENUM_TABLE` row (if it had one), then bump the constant.
 * Bumping the number without that decision is the one way to defeat this tripwire.
 */
// Triage for TenantClass (Phase 0 T1, 2026-09-13): originally left unmirrored — server-only,
// no web/mobile surface read or hand-typed it. The 743 fix round (T1, F1/N6) adds the shared
// `TENANT_CLASS_VALUES` mirror (`packages/types/api/enums.ts`) + an `ENUM_TABLE` row above,
// consumed by `create-tenant.dto.ts`'s `@IsIn` and the admin "New Tenant" form — see
// REG-743-N6 below.
//
// Triage for CheckReturnReason (post-dated check payments PR-1, 2026-09-15): a brand-new enum,
// added with its `CHECK_RETURN_REASON_VALUES` mirror + `ENUM_TABLE` row in the SAME PR (unlike
// PaymentStatus gaining `PENDING` or NotificationEvent gaining `CHECK_RETURNED`, which add a
// VALUE to an enum this file already tracks/doesn't track — those never move this count).
// Triage for ReturnKind (Returns Inside Order Creation, PR-1a, 2026-09-15): new Prisma enum,
// mirrored immediately as `RETURN_KIND_VALUES` + an `ENUM_TABLE` row above — the value
// (STANDARD/INLINE) is read by every `kind`-branching returns.service.ts method landing in
// this PR. `RETURN_HOLD_REASON_VALUES`/`RETURN_PRICE_SOURCE_VALUES` (same file) are NOT
// generated Prisma enums (plain-string columns, see Return.holdReason's schema comment), so
// they add no row here and do not move this count.
// Triage for MailboxProvider/MailboxConnectionStatus (email-connect-google, PR-2, 2026-09-17):
// two brand-new Prisma enums, mirrored immediately as `MAILBOX_PROVIDER_VALUES`/
// `MAILBOX_CONNECTION_STATUS_VALUES` + their `ENUM_TABLE` rows in this same PR.
// Triage for FeatureOverrideEffect (Feature grants PR-1, 2026-09-16): new Prisma enum, mirrored
// immediately as `FEATURE_OVERRIDE_EFFECT_VALUES` + an `ENUM_TABLE` row above — read by
// `FeatureOverrideService` to decide GRANT/DENY.
// Triage for DemoBookingStatus (public demo booking, 2026-09-16): new Prisma enum, mirrored
// immediately as `DEMO_BOOKING_STATUS_VALUES` + an `ENUM_TABLE` row above.
// (2026-09-17, email-connect-google merge onto master post-#811): three independent lanes each
// bumped this constant off their own base; merged, the true count is verified directly via
// `Object.keys(PrismaEnums.$Enums).length` against the MERGED Prisma client, never summed by
// hand — see the value actually asserted below.
const PINNED_PRISMA_ENUM_COUNT = 90;

describe("enum triage tripwire: generated Prisma enum count (L-072)", () => {
  it("pins the number of generated Prisma enums — a new enum must be triaged into ENUM_TABLE or explicitly left unmirrored", () => {
    expect(Object.keys(PrismaEnums.$Enums).length).toBe(PINNED_PRISMA_ENUM_COUNT);
    // ENUM_TABLE is the mirrored subset, never the whole set — a future edit that turns this
    // into an equality assertion would be wrong, so pin the relationship it actually has.
    expect(ENUM_TABLE.length).toBeLessThan(PINNED_PRISMA_ENUM_COUNT);
  });
});

// ─── Regression layer: the four confirmed drifts (3 from the bug card + 1 sibling-sweep find) ──

/**
 * Extracts `export type <name> = "A" | "B" | ...;` from a file's raw text, or
 * null if not found — including when `<name>` is now a plain alias to an
 * IDENTIFIER (`export type POStatus = PurchaseOrderStatus;`, zero quoted
 * literals) rather than a hand-typed union: that shape is the fix, not the
 * drift, so it must fall through to the `importsFromSharedPackage` check too.
 */
function extractLocalLiteralUnion(filePath: string, typeName: string): string[] | null {
  const text = fs.readFileSync(filePath, "utf8");
  const re = new RegExp(`export type ${typeName}\\s*=([^;]+);`, "m");
  const m = text.match(re);
  if (!m) return null;
  const literals = Array.from(m[1].matchAll(/"([A-Z_]+)"/g)).map((mm) => mm[1]);
  return literals.length > 0 ? literals : null;
}

/** Extracts the inline literal union of a named field inside an `export interface <iface> { ... }` block. */
function extractInlineFieldUnion(
  filePath: string,
  ifaceName: string,
  fieldName: string,
): string[] | null {
  const text = fs.readFileSync(filePath, "utf8");
  const ifaceRe = new RegExp(`export interface ${ifaceName} \\{([\\s\\S]*?)\\n\\}`, "m");
  const ifaceMatch = text.match(ifaceRe);
  if (!ifaceMatch) return null;
  const fieldRe = new RegExp(`\\b${fieldName}\\s*:\\s*([^;\\n]+)[;\\n]`);
  const fieldMatch = ifaceMatch[1].match(fieldRe);
  if (!fieldMatch) return null;
  const literals = Array.from(fieldMatch[1].matchAll(/"([A-Z_]+)"/g)).map((mm) => mm[1]);
  return literals.length > 0 ? literals : null;
}

/** True once the file imports `typeName` from the shared package (post-fix expected state). */
function importsFromSharedPackage(filePath: string, typeName: string): boolean {
  const text = fs.readFileSync(filePath, "utf8");
  const importRe = new RegExp(
    `import[^;]*\\btype\\b[^;]*\\b${typeName}\\b[^;]*from ["']@routeflow/types["']|` +
      `import[^;]*\\{[^}]*\\b${typeName}\\b[^}]*\\}[^;]*from ["']@routeflow/types["']`,
  );
  return importRe.test(text);
}

describe("regression: hand-typed web/mobile enum mirrors must not re-drift (L-072)", () => {
  it.each([
    ["mobile", "apps/mobile/lib/api/vendor-bills.ts"],
    // Close-out review (2026-09-05): web hand-typed the same union, also missing
    // "OVERDUE" — pinned here the same way mobile was in wave E (L-072).
    ["web", "apps/web/lib/api/vendor-bills.ts"],
  ])("%s VendorBillStatus (%s) matches Prisma VendorBillStatus", (_app, relPath) => {
    const file = path.join(REPO_ROOT, relPath);
    const local = extractLocalLiteralUnion(file, "VendorBillStatus");
    const expected = Object.values(PrismaEnums.VendorBillStatus);
    if (local) {
      // Still hand-declared — this is what fails TODAY: "FULL" present, "OVERDUE" missing.
      expect(new Set(local)).toEqual(new Set(expected));
    } else {
      expect(importsFromSharedPackage(file, "VendorBillStatus")).toBe(true);
    }
  });

  it("mobile POStatus (apps/mobile/lib/api/purchase-orders.ts) matches Prisma PurchaseOrderStatus", () => {
    const file = path.join(REPO_ROOT, "apps/mobile/lib/api/purchase-orders.ts");
    const local = extractLocalLiteralUnion(file, "POStatus");
    const expected = Object.values(PrismaEnums.PurchaseOrderStatus);
    if (local) {
      // Fails TODAY: "PARTIALLY_RECEIVED" present instead of "PARTIAL".
      expect(new Set(local)).toEqual(new Set(expected));
    } else {
      expect(importsFromSharedPackage(file, "PurchaseOrderStatus")).toBe(true);
    }
  });

  it("mobile BuyerPromotion.type (apps/mobile/lib/api/buyer.ts) matches Prisma PromotionType", () => {
    const file = path.join(REPO_ROOT, "apps/mobile/lib/api/buyer.ts");
    const local = extractInlineFieldUnion(file, "BuyerPromotion", "type");
    const expected = Object.values(PrismaEnums.PromotionType);
    if (local) {
      // Fails TODAY: "BUY_N_GET_M" missing from the inline union.
      expect(new Set(local)).toEqual(new Set(expected));
    } else {
      // Post-fix: the whole `BuyerPromotion` interface (whose `type` field is
      // typed from the shared `PromotionType`) is imported, not just the enum
      // name in isolation — either marker proves the fix landed.
      expect(
        importsFromSharedPackage(file, "PromotionType") ||
          importsFromSharedPackage(file, "BuyerPromotion"),
      ).toBe(true);
    }
  });

  it.each([
    ["mobile", "apps/mobile/lib/api/estimates.ts"],
    ["web", "apps/web/lib/api/estimates.ts"],
  ])(
    "%s EstimateStatus (%s) matches Prisma EstimateStatus (sibling-sweep find: phantom EXPIRED)",
    (_app, relPath) => {
      const file = path.join(REPO_ROOT, relPath);
      const local = extractLocalLiteralUnion(file, "EstimateStatus");
      const expected = Object.values(PrismaEnums.EstimateStatus);
      if (local) {
        // Fails TODAY on both apps: "EXPIRED" is not a real EstimateStatus value.
        expect(new Set(local)).toEqual(new Set(expected));
      } else {
        expect(importsFromSharedPackage(file, "EstimateStatus")).toBe(true);
      }
    },
  );
});

// ─── REG-743-N6: TenantClass mirror is pinned (743 fix round, T1) ─────────────

describe("REG-743-N6: TenantClass mirror is pinned", () => {
  it("TenantClass mirror is pinned", () => {
    // No `TENANT_CLASS_VALUES` export exists in packages/types/api/enums.ts yet
    // (see the triage note above `PINNED_PRISMA_ENUM_COUNT`) — `SHARED` therefore
    // has no such key and `readSharedEnums()`'s import guard falls through to an
    // empty actual array, which can never equal the four real Prisma values.
    // Fails on head with the empty-array vs. 4-member mismatch; passes once
    // `packages/types/api/enums.ts` exports `TENANT_CLASS_VALUES`/`TenantClass`
    // set-equal to `@prisma/client`'s `TenantClass` enum.
    const actual = Array.isArray((SHARED as Record<string, unknown>)["TENANT_CLASS_VALUES"])
      ? ((SHARED as Record<string, unknown>)["TENANT_CLASS_VALUES"] as unknown[])
      : [];
    const expected = Object.values(PrismaEnums.TenantClass);
    expect(new Set(actual)).toEqual(new Set(expected));
    expect(expected.length).toBeGreaterThan(0);
  });
});

// ─── REG-743-F4: PLAN_KEYS's two independent mirrors must not drift (L-072) ────

/**
 * PLAN_KEYS is NOT a generated Prisma enum (it's the plans-as-data catalog vocabulary), so it
 * doesn't fit ENUM_TABLE above -- but `plan-catalog.constants.ts` deliberately mirrors it
 * locally rather than value-importing `@routeflow/types` (a boot-crash-class rule: the API
 * compiles to `dist/` via `nest build`, which does not bundle workspace deps, and
 * `@routeflow/types` ships raw TypeScript with no build step — see
 * `no-runtime-workspace-imports.spec.ts`). Two independent hand-typed copies of the same
 * vocabulary is exactly the L-072 drift class this file exists to catch, so pin them
 * set-equal here.
 */
describe("REG-743-F4: plan-catalog.constants PLAN_KEYS matches @routeflow/types PLAN_KEYS (L-072)", () => {
  it("the API's local PLAN_KEYS mirror is set-equal to the shared package's PLAN_KEYS", () => {
    const shared = Array.isArray((SHARED as Record<string, unknown>)["PLAN_KEYS"])
      ? ((SHARED as Record<string, unknown>)["PLAN_KEYS"] as unknown[])
      : [];
    expect(new Set(API_PLAN_KEYS)).toEqual(new Set(shared));
    expect(shared.length).toBeGreaterThan(0); // guard against a bad export silently vacuous-passing
  });
});

// ─── Regression: apps/mobile's hand-copied runtime stub must stay pinned (X2) ──

/**
 * `apps/mobile/__tests__/__mocks__/@routeflow/types.js` hand-copies every
 * `*_VALUES` const array it needs because ts-jest's transformIgnorePatterns
 * excludes node_modules, so the real `.ts` source can't be transformed
 * through the symlinked `@routeflow/types` package for pure-logic mobile
 * tests (see the stub's own header). That hand copy is exactly the kind of
 * drift-prone mirror this spec exists to catch — pin it directly: `require`
 * the stub by relative path and diff every `*_VALUES` export it defines
 * against `Object.values()` of the correspondingly-named `@prisma/client`
 * enum (strip `_VALUES`, PascalCase each `_`-separated part: e.g.
 * `VENDOR_BILL_STATUS_VALUES` → `VendorBillStatus`). A stub export whose
 * name maps to no Prisma enum fails naming that export (via the `%s` title).
 */
const MOBILE_STUB_PATH = path.join(
  __dirname,
  "../../../mobile/__tests__/__mocks__/@routeflow/types.js",
);

function readMobileStub(): Record<string, unknown> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(MOBILE_STUB_PATH) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const MOBILE_STUB = readMobileStub();
const MOBILE_STUB_VALUE_KEYS = Object.keys(MOBILE_STUB).filter((k) => k.endsWith("_VALUES"));

/** `VENDOR_BILL_STATUS_VALUES` → `VendorBillStatus`. */
function stubKeyToPrismaEnumName(key: string): string {
  return key
    .slice(0, -"_VALUES".length)
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join("");
}

// ─── WP1 T2: LITE plan-key + FLAG_KEYS parity across enums.ts / plan-catalog.constants.ts ─────

/**
 * T2 (WP1, lite-L2 plan): fails TODAY because the shared `FLAG_KEYS` export in
 * `packages/types/api/billing.ts` doesn't exist yet (`[]` vs the expected 21 keys) and the
 * generated Prisma `TenantPlan` enum doesn't contain `"LITE"` yet.
 */
describe("WP1 T2: LITE PLAN_KEYS (5 members) + FLAG_KEYS (21 keys) parity, Prisma TenantPlan has LITE", () => {
  it("API PLAN_KEYS (5 members) is set-equal to the shared package's PLAN_KEYS (REG-743-F4, now with LITE)", () => {
    const shared = Array.isArray((SHARED as Record<string, unknown>)["PLAN_KEYS"])
      ? ((SHARED as Record<string, unknown>)["PLAN_KEYS"] as unknown[])
      : [];
    expect(new Set(API_PLAN_KEYS)).toEqual(new Set(shared));
    expect(shared.length).toBe(5);
  });

  it("API FLAG_KEYS (21 keys) is set-equal to the shared package's FLAG_KEYS", () => {
    const shared = Array.isArray((SHARED as Record<string, unknown>)["FLAG_KEYS"])
      ? ((SHARED as Record<string, unknown>)["FLAG_KEYS"] as unknown[])
      : [];
    expect(new Set(API_FLAG_KEYS)).toEqual(new Set(shared));
    expect(shared.length).toBe(21);
  });

  it("generated Prisma TenantPlan enum contains LITE", () => {
    const values = Object.values(PrismaEnums.TenantPlan as unknown as Record<string, string>);
    expect(values).toContain("LITE");
  });
});

// ─── WP1 T3: additive-only LITE migration exists, exactly one dir, no destructive statements ──

/**
 * T3 (WP1, lite-L2 plan): fails TODAY because no `*_tenant_plan_lite` migration directory
 * exists yet under `apps/api/prisma/migrations/`.
 */
describe("WP1 T3: tenant-plan-lite migration is additive-only", () => {
  const MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/api/prisma/migrations");

  it("exactly one migration dir matches *_tenant_plan_lite and its SQL is the exact additive statement", () => {
    const entries = fs.existsSync(MIGRATIONS_DIR) ? fs.readdirSync(MIGRATIONS_DIR) : [];
    const matches = entries.filter((name) => /_tenant_plan_lite$/.test(name));
    expect(matches.length).toBe(1);

    const migrationFile = path.join(MIGRATIONS_DIR, matches[0], "migration.sql");
    const raw = fs.readFileSync(migrationFile, "utf8");
    // Strip `--` line comments and blank lines, then compare the remaining SQL exactly.
    const stripped = raw
      .split("\n")
      .map((line) => line.replace(/--.*$/, "").trim())
      .filter((line) => line.length > 0)
      .join("\n");
    expect(stripped).toBe(`ALTER TYPE "TenantPlan" ADD VALUE 'LITE';`);

    expect(raw).not.toMatch(/\bDROP\b/i);
    expect(raw).not.toMatch(/\bRENAME\b/i);
    expect(raw).not.toMatch(/ALTER\s+COLUMN/i);
  });
});

describe("regression: apps/mobile's @routeflow/types stub stays pinned to Prisma (X2)", () => {
  it("the stub declares at least one *_VALUES export (guards against a silently-vacuous suite)", () => {
    expect(MOBILE_STUB_VALUE_KEYS.length).toBeGreaterThan(0);
  });

  it.each(MOBILE_STUB_VALUE_KEYS)(
    "stub export %s maps to a real Prisma enum and set-equals its values",
    (key) => {
      const prismaEnumName = stubKeyToPrismaEnumName(key);
      const prismaEnum = PrismaEnums[prismaEnumName as keyof typeof PrismaEnums] as
        Record<string, string> | undefined;
      expect(prismaEnum).toBeDefined();
      const expected = Object.values(prismaEnum ?? {});
      expect(new Set(MOBILE_STUB[key] as unknown[])).toEqual(new Set(expected));
      expect(expected.length).toBeGreaterThan(0);
    },
  );

  // Post-dated check payments PR-1 (2026-09-15, MINOR 4 fix round): the stub's own header notes
  // `CHECK_TRANSITIONS` is deliberately named WITHOUT the `_VALUES` suffix (it isn't a Prisma
  // enum-values array, so the sweep above never reaches it) and is otherwise unguarded — a future
  // V2 change to the real table could drift from this hand copy with nothing to catch it. Pin it
  // directly against `packages/types/api/checks.ts`'s canonical export (via `SHARED`, the same
  // `@routeflow/types` require the rest of this file already uses).
  it("stub export CHECK_TRANSITIONS (unswept by the *_VALUES check above) stays deep-equal to the canonical @routeflow/types export", () => {
    const canonical = (SHARED as Record<string, unknown>)["CHECK_TRANSITIONS"];
    expect(canonical).toBeDefined();
    expect(MOBILE_STUB["CHECK_TRANSITIONS"]).toEqual(canonical);
  });
});
