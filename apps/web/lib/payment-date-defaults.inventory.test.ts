import * as fs from "fs";
import * as path from "path";
import { todayIso } from "./formatting";
import { tenantDateOf, tenantTodayIso } from "./tenant-timezone";

/**
 * SA-943 PR-A (W-765): a payment / settled / received date box defaults to the BUSINESS's today in its zone, and an edit
 * box shows the stored instant's tenant-local day. `todayIso()` is the UTC day (`toISOString()`): at 20:00 CDT on 10-24
 * it is already "2026-10-25", so a same-day payment was sent as tomorrow (and the edit form re-sent a 21:00 CDT payment
 * as the next UTC day, re-stamping it).
 *
 * The INVENTORY half (L-305): every payment-date form reads `tenantTodayIso`, none builds its default from the UTC day,
 * and the files still importing `todayIso` are an exact, reviewed list - a new caller fails here instead of shipping.
 */
const WEB = path.resolve(__dirname, "..");
const CHI = "America/Chicago";
const at2000CdtOct24 = new Date("2026-10-25T01:00:00.000Z");

describe("tenantTodayIso / tenantDateOf (SA-943)", () => {
  it("20:00 CDT on 10-24 is 2026-10-24 for a Chicago business (the UTC todayIso says 10-25)", () => {
    expect(tenantTodayIso(CHI, at2000CdtOct24)).toBe("2026-10-24");
    jest.useFakeTimers().setSystemTime(at2000CdtOct24);
    try {
      expect(todayIso()).toBe("2026-10-25"); // the wrong value the forms used to send
    } finally {
      jest.useRealTimers();
    }
  });

  it("an east-of-UTC business is already on the next day", () => {
    expect(tenantTodayIso("Asia/Tokyo", new Date("2026-10-24T16:00:00.000Z"))).toBe("2026-10-25");
  });

  it("the edit box shows a 21:00 CDT payment on 10-21 as 2026-10-21, not the UTC 10-22", () => {
    expect(tenantDateOf("2026-10-22T02:00:00.000Z", CHI)).toBe("2026-10-21");
    expect(tenantDateOf(null, CHI)).toBe("");
  });
});

/** The payment-date forms SA-943 moved onto the tenant's day. */
const PAYMENT_FORMS = [
  "app/(dashboard)/invoices/[id]/page.tsx",
  "app/(dashboard)/finance/payments/page.tsx",
  "app/(dashboard)/finance/commissions/_components/RecordPayoutModal.tsx",
  "app/(dashboard)/vendor-bills/page.tsx",
  "components/CustomerRecordPaymentModal.tsx",
  "components/RecordSupplierPaymentModal.tsx",
];
const UTC_DAY_DEFAULT =
  /(?:paidAt|settledAt|receivedAt|markPaidDate)\b[^\n]*(?:todayIso\(\)|toISOString\(\)\.(?:split\("T"\)\[0\]|slice\(0,\s*10\)))/;

/**
 * Files still importing the UTC `todayIso` from lib/formatting, each reviewed: CALENDAR fields (issue / due / bill dates,
 * effective-from), never a payment instant. Moving them is a separate change; adding one here is a review decision.
 */
const TODAY_ISO_IMPORTERS = [
  "app/(dashboard)/sales-agents/[id]/page.tsx",
  "app/(dashboard)/sales-agents/_components/AgentFormModal.tsx",
  "app/(dashboard)/sales-agents/_components/AssignCustomersModal.tsx",
  "app/(dashboard)/vendor-bills/page.tsx",
  "components/StatementReviewGrid.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(WEB, f).split(path.sep).join("/");

describe("payment-date defaults inventory (SA-943)", () => {
  it.each(PAYMENT_FORMS)("%s defaults the paid date to the tenant's day", (file) => {
    const src = fs.readFileSync(path.join(WEB, file), "utf8");
    expect(src).toMatch(/\btenantTodayIso\(/);
    expect(src).not.toMatch(UTC_DAY_DEFAULT);
  });

  it("the invoice edit box shows the stored instant's tenant-local day (no UTC slice)", () => {
    const src = fs.readFileSync(path.join(WEB, "app/(dashboard)/invoices/[id]/page.tsx"), "utf8");
    expect(src).toMatch(/paidAt: tenantDateOf\(payment\.paidAt \?\? payment\.createdAt, zone\)/);
    expect(src).not.toMatch(/function dateInputValue/);
  });

  it("the files importing the UTC todayIso are exactly the reviewed calendar-field list", () => {
    const importers = ["app", "components"]
      .flatMap((d) => walk(path.join(WEB, d)))
      .filter((f) =>
        /import \{[^}]*\btodayIso\b[^}]*\} from "@\/lib\/formatting"/.test(
          fs.readFileSync(f, "utf8"),
        ),
      )
      .map(rel)
      .sort();
    expect(importers).toEqual([...TODAY_ISO_IMPORTERS].sort());
  });
});
