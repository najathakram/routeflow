import * as fs from "fs";
import * as path from "path";

/**
 * SA-964 §4 / OP-7: a screen's "today" is the TENANT's day (`useTenantToday`, lib/tenant-timezone.ts), never the
 * browser's. This structural pin counts the browser-clock idioms (a `new Date()` rendered to its UTC day, a
 * `new Date(new Date().toDateString())`, a local `todayIso`, `setHours(0, 0, 0, 0)`) per file outside
 * `lib/tenant-timezone.ts`. It is SHRINK-ONLY: a file may hold at most its baseline count, and a file that is not listed
 * holds none, so a NEW browser-clock site goes red. Fixing a site? Lower (or delete) its number below.
 *
 * Many remaining entries are legitimate file-name stamps ("orders-2026-10-25.csv"); the rest are listed follow-ups:
 *   - vendor-bills/page.tsx: waits for #3742 (same file);
 *   - buyer licenses: a buyer token cannot read /settings, so it needs a buyer-readable tenant zone first;
 *   - finance/payments and the two payment modals: #3742 rewrites them, then the follow-up converts them;
 *   - invoices/new issue and due dates: waits for #3775 (row 750 edits the same lines);
 *   - the rest are file-name stamps (orders-2026-10-25.csv) and one-off display dates, not prefilled saved fields.
 */
const BASELINE: Record<string, number> = {
  "app/(dashboard)/customers/[id]/page.tsx": 3,
  "app/(dashboard)/finance/reports/page.tsx": 1,
  "app/(dashboard)/finance/payments/page.tsx": 1, // #3742 rewrites this (and the two modals below)
  "app/(dashboard)/invoices/[id]/edit/page.tsx": 1,
  "app/(dashboard)/invoices/new/page.tsx": 2,
  "app/(dashboard)/invoices/page.tsx": 1,
  "app/(dashboard)/orders/_components/CreateOrderModal.tsx": 1,
  "app/(dashboard)/orders/page.tsx": 1,
  "app/(dashboard)/vendor-bills/page.tsx": 1,
  "app/(platform-admin)/admin/billing/page.tsx": 1,
  "app/buyer/portal/[seller]/licenses/page.tsx": 2,
  "components/CustomerRecordPaymentModal.tsx": 1,
  "components/RecordSupplierPaymentModal.tsx": 1,
  "lib/api/invoices.ts": 1,
  "lib/export.ts": 1,
  "lib/formatting.ts": 2,
  "lib/json-export.ts": 1,
};

const WEB = path.resolve(__dirname, "..");
const IDIOMS = new RegExp(
  [
    String.raw`new Date\(\)\.toISOString\(\)\.(?:slice\(0, ?10\)|split\("T"\)\[0\])`,
    String.raw`new Date\(new Date\(\)\.toDateString\(\)\)`,
    String.raw`(?:const|function) todayIso\b`,
    String.raw`setHours\(0, ?0, ?0, ?0\)`,
  ].join("|"),
  "g",
);
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".next" ? [] : walk(p);
    return /\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) ? [p] : [];
  });
const counts = (): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const root of ["app", "components", "lib"]) {
    for (const f of walk(path.join(WEB, root))) {
      const rel = path.relative(WEB, f).split(path.sep).join("/");
      if (rel === "lib/tenant-timezone.ts") continue;
      const n = (fs.readFileSync(f, "utf8").match(IDIOMS) ?? []).length;
      if (n > 0) out[rel] = n;
    }
  }
  return out;
};

describe("browser-clock 'today' idioms (SA-964 §4): shrink-only", () => {
  it("no file holds more than its baseline, and no unlisted file holds any", () => {
    const over = Object.entries(counts())
      .filter(([f, n]) => n > (BASELINE[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} (baseline ${BASELINE[f] ?? 0})`);
    expect(over).toEqual([]);
  });

  it("the idiom matcher sees what it should (positive control)", () => {
    const sample =
      'const a = new Date().toISOString().slice(0, 10); const b = new Date().toISOString().split("T")[0];' +
      " const c = new Date(new Date().toDateString()); const todayIso = () => 1; d.setHours(0, 0, 0, 0);";
    expect((sample.match(IDIOMS) ?? []).length).toBe(5);
    expect(
      "const x = new Date(row.createdAt).toISOString().slice(0, 10);".match(IDIOMS),
    ).toBeNull();
  });
});
