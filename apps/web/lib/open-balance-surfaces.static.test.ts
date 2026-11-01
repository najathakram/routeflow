import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * SA-1078 U21: every staff surface that prints a customer's open balance prints it inside `OpenBalanceButton`, so a tap
 * always opens the one statement sheet and no figure is left plain by accident. A new surface that prints the figure adds
 * itself to SURFACES (or to PLAIN_ON_PURPOSE with the reason); the file-set guard below fails until it does.
 */
const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Each entry: the file, and a regex whose every match is one printed open-balance figure. */
const SURFACES: { file: string; label: string; figure: RegExp }[] = [
  {
    file: "app/(dashboard)/customers/[id]/page.tsx",
    label: "customer page top tile and Billing tab",
    figure: /statementMoney\(statement, statementFailed, \(x\) => x\.outstandingAmount, fmt\)/g,
  },
  {
    file: "app/(dashboard)/customers/[id]/page.tsx",
    label: "Invoices tab Open balance card",
    figure: /\{outstandingText\}/g,
  },
  {
    file: "app/(dashboard)/customers/[id]/customer-statement-card.tsx",
    label: "Account history tile and foot",
    figure: /\{balanceDue\}/g,
  },
  {
    file: "app/(dashboard)/orders/_components/CounterCustomerCredit.tsx",
    label: "counter",
    figure: /\{fmt\(v\)\}/g,
  },
  {
    file: "components/CustomerAccountStrip.tsx",
    label: "New order strip",
    figure: /\{parts\[0\]\}/g,
  },
  {
    file: "app/(dashboard)/customers/page.tsx",
    label: "customers list Open balance column",
    figure: /\{fmt\(balance\)\}/g,
  },
  {
    file: "app/(dashboard)/finance/reports/page.tsx",
    label: "AR aging total",
    figure: /\{fmt\(rowTotal\)\}/g,
  },
  {
    file: "app/(dashboard)/finance/reports/page.tsx",
    label: "Customer Balance Summary balance",
    figure: /\{fmt\(r\.balance\)\}<\/OpenBalanceButton>/g,
  },
];

/** Files that read the figure but do not print it for staff (or print the buyer's own, PR-6), with the reason. */
const PLAIN_ON_PURPOSE: Record<string, string> = {
  "components/account-statement/AccountStatementSheet.tsx": "the statement view itself",
  "app/buyer/portal/[seller]/payments/page.tsx":
    "the buyer's own portal (PR-6 gives it the buyer sheet)",
};

/** True when `index` sits between an opening `<OpenBalanceButton` and its closing tag. */
function insideButton(src: string, index: number): boolean {
  const before = src.slice(0, index);
  return before.lastIndexOf("<OpenBalanceButton") > before.lastIndexOf("</OpenBalanceButton>");
}

describe("U21: the open-balance figure is only printed inside OpenBalanceButton", () => {
  it.each(SURFACES)("$label ($file)", ({ file, figure }) => {
    const src = read(file);
    const hits = [...src.matchAll(figure)];
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(insideButton(src, h.index!)).toBe(true);
  });

  it("no other staff file reads the statement's open balance without being listed", () => {
    const files = execSync(
      'git grep -l -E "outstandingAmount|openBalance" -- "*.tsx" ":!*.test.tsx"',
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    const known = new Set([...SURFACES.map((s) => s.file), ...Object.keys(PLAIN_ON_PURPOSE)]);
    expect(files.filter((f) => !known.has(f))).toEqual([]);
  });
});

describe("U22: one name for the figure on the customer page", () => {
  const page = read("app/(dashboard)/customers/[id]/page.tsx");
  const card = read("app/(dashboard)/customers/[id]/customer-statement-card.tsx");
  it("says Open balance, never Outstanding or Balance Due as the figure's label", () => {
    expect(page).not.toMatch(/label="Open Balance"/);
    expect(page).not.toMatch(/>\s*Open Balance\s*</);
    expect(card).not.toMatch(/label: "Balance Due"/);
    expect(card).not.toMatch(/>\s*Balance Due\s*</);
  });
});
