import { readFileSync } from "fs";
import { join } from "path";

/**
 * F14 (SA-964 §4): the scan-invoice dates and the compliance report range start from the TENANT's day, never the browser's.
 * Static reads, like scan-invoice-intent.static.test.ts: both screens need a long chain of mocks to render, and the property
 * is structural (no browser-clock idiom seeds a date; the report waits for the tenant's day before it queries).
 */
const WEB = join(__dirname, "..");
const scan = readFileSync(join(WEB, "components", "ScanInvoiceModal.tsx"), "utf8");
const pack = readFileSync(
  join(
    WEB,
    "app",
    "(dashboard)",
    "compliance",
    "[categoryId]",
    "_components",
    "CompliancePackPanel.tsx",
  ),
  "utf8",
);
const BROWSER_DAY = /new Date\(\)\.toISOString\(\)\.(?:slice\(0, ?10\)|split\("T"\)\[0\])/;

describe("F14: dates use the tenant's day", () => {
  it("a new scanned invoice starts with empty bill and expense dates, not the browser's day", () => {
    expect(scan).not.toMatch(BROWSER_DAY);
    expect(scan).toMatch(/billDate: "",/);
    expect(scan).toMatch(/expenseDate: "",/);
  });

  it("an empty bill or expense date is filled from the tenant's day once the zone is known, and only when empty", () => {
    expect(scan).toContain("useTenantToday()");
    expect(scan).toContain("billDate: inv.billDate || tenantToday");
    expect(scan).toContain("expenseDate: inv.expenseDate || tenantToday");
  });

  it("the expense cannot be saved while its date is still unknown", () => {
    expect(scan).toContain('if (!inv.expenseDate) throw new Error("Pick the expense date.")');
  });

  it("the report range seeds from the tenant's day and nothing is queried before it is known", () => {
    expect(pack).not.toMatch(BROWSER_DAY);
    expect(pack).toContain("useOnTenantToday(");
    expect(pack.match(/enabled: !!range\.from && !!range\.to/g)).toHaveLength(2);
  });
});
