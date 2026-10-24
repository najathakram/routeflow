import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * W-882 pin: money text prints through `formatMoney` (lib/format), never by hand. Hand-rolled `$${x.toFixed(2)}` has no
 * thousands grouping ("$12345.67"), prints "-$0.00" / "$NaN", and drifts from the receipt. Per-file maximums can only go
 * DOWN: when you convert a site, lower its number; a new site in a file not listed here fails at 0.
 */
const WEB = join(__dirname, "..", "..", "..");
const ROOTS = [
  join(WEB, "app", "(dashboard)", "orders"),
  join(WEB, "components", "LineItemRow.tsx"),
];

/** a template `$${…toFixed(`, a JSX `$` + `{…toFixed(2)}` / `{…toLocaleString(`, or `"$" +` */
export const HAND_MONEY = [
  /\$\$\{[^}]*toFixed\(/,
  /\$\{[^}]*(?:toFixed\(2\)|toLocaleString\()[^}]*\}/,
  /["']\$["']\s*\+/,
];

export const countHandMoney = (src: string): number =>
  src.split("\n").filter((line) => HAND_MONEY.some((re) => re.test(line))).length;

/** Remaining hand-rolled sites, by path relative to apps/web. Lower only. */
const MAX: Record<string, number> = {
  "app/(dashboard)/orders/[id]/price-edit-row.tsx": 4,
  "app/(dashboard)/orders/_components/scan/PriceEditor.tsx": 6,
  "app/(dashboard)/orders/_components/CreditNotePicker.tsx": 3,
  "app/(dashboard)/orders/_components/SplitInvoiceModal.tsx": 2,
  "app/(dashboard)/orders/page.tsx": 1,
  "app/(dashboard)/orders/_components/scan/ScanOrderScreen.tsx": 1,
  "app/(dashboard)/orders/_components/CounterDayClose.tsx": 1,
};

function walk(p: string, out: string[] = []): string[] {
  if (statSync(p).isFile()) return /\.tsx?$/.test(p) ? [...out, p] : out;
  for (const e of readdirSync(p)) {
    const f = join(p, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.tsx?$/.test(e) && !/\.(test|spec)\.tsx?$/.test(e) && !/\.pin\.test/.test(e))
      out.push(f);
  }
  return out;
}

describe("money text pin (W-882)", () => {
  it("catches a hand-rolled money template (fixture)", () => {
    expect(countHandMoney("const a = `$${x.toFixed(2)}`;")).toBe(1);
    expect(countHandMoney("<span>${total.toFixed(2)}</span>")).toBe(1);
    expect(countHandMoney('const b = "$" + n;')).toBe(1);
    expect(countHandMoney("const c = formatMoney(n);")).toBe(0);
  });

  it("no file prints money by hand beyond its recorded maximum", () => {
    const over: string[] = [];
    for (const root of ROOTS) {
      for (const f of walk(root)) {
        const rel = relative(WEB, f).split(sep).join("/");
        const n = countHandMoney(readFileSync(f, "utf8"));
        const max = MAX[rel] ?? 0;
        if (n > max)
          over.push(`${rel}: ${n} hand-rolled money sites (max ${max}) - use formatMoney`);
      }
    }
    expect(over).toEqual([]);
  });
});
