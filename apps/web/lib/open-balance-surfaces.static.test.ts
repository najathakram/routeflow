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
const SURFACES: { file: string; label: string; figure: RegExp; tag?: string }[] = [
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
  {
    file: "app/buyer/portal/[seller]/payments/page.tsx",
    label: "buyer portal Payments page Outstanding card (PR-6)",
    figure: /\{fmt\(statement\?\.outstandingAmount \?\? 0\)\}/g,
    tag: "BuyerOpenBalanceButton",
  },
];

/** Files that read the figure but do not print it for staff, with the reason. */
const PLAIN_ON_PURPOSE: Record<string, string> = {
  "components/account-statement/AccountStatementSheet.tsx": "the statement view itself",
};

/** True when `index` sits between an opening `<OpenBalanceButton` and its closing tag. */
function insideButton(src: string, index: number, tag = "OpenBalanceButton"): boolean {
  const before = src.slice(0, index);
  return before.lastIndexOf(`<${tag}`) > before.lastIndexOf(`</${tag}>`);
}

describe("U21: the open-balance figure is only printed inside OpenBalanceButton", () => {
  it.each(SURFACES)("$label ($file)", ({ file, figure, tag }) => {
    const src = read(file);
    const hits = [...src.matchAll(figure)];
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(insideButton(src, h.index!, tag)).toBe(true);
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

describe("A-4: a host of OpenBalanceButton never hides its rows on a background refresh", () => {
  // Closing the sheet refreshes ["reports"]; a `isLoading || isFetching ?` gate unmounts the tapped figure and drops focus.
  // AR aging and Customer Balance Summary moved to `isLoading ?`. The 14 left on the reports page host no button; a report
  // moving to `isLoading` lowers the 14. The pin only shrinks.
  const GATE = /isLoading \|\| isFetching \?/g;
  it("the reports page keeps exactly 14 isLoading || isFetching gates", () => {
    expect(read("app/(dashboard)/finance/reports/page.tsx").match(GATE)?.length ?? 0).toBe(14);
  });
  it.each([
    "app/(dashboard)/customers/[id]/page.tsx",
    "app/(dashboard)/customers/[id]/customer-statement-card.tsx",
    "app/(dashboard)/orders/_components/CounterCustomerCredit.tsx",
    "components/CustomerAccountStrip.tsx",
  ])("%s has none", (file) => {
    expect(read(file).match(GATE)?.length ?? 0).toBe(0);
  });
});
