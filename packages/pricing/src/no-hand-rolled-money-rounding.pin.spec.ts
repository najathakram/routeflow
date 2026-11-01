/**
 * SA-1048 (I-169): the money-rounding inventory pin.
 *
 * Money is rounded one way: `roundMoney` (half away from zero, after the REG-B122 4-decimal snap). A hand
 * `Math.round(x * 100) / 100` rounds -0.125 toward zero, `x.toFixed(2)` prints 1.005 as "1.00", and each
 * helper written beside the real one is how a cent drifted between the screen, the stored row and the PDF.
 * This spec walks the apps and packages and fails on any hand-rolled cents round that is not on the
 * allowlist below.
 *
 * Forms (comments stripped first):
 *   F1  `Math.round(E * 100) / 100` (any spacing, any line breaks, or `100 * E`)
 *   F2  `Number(E.toFixed(2))`, `parseFloat(E.toFixed(2))` or `+E.toFixed(2)`
 *   F3  `Math.round(E * 100)` with no `/ 100` after it, E not starting with `roundMoney(`
 *   F4  a `.toFixed(2)` whose receiver is not a `roundMoney(...)` call. In `apps/api/src` every one counts
 *       (stored Decimal strings and customer documents). In `apps/web` and `apps/mobile` only one inside
 *       `useState(`, a `set[A-Z]...(` setter, `reset(` or a `defaultValues` object counts: those are the
 *       values a person then submits. A display-only `toFixed(2)` in a component is Intl-class and is left.
 *
 * Allowlist: `{ file, form, count, why, note }` with an EXACT count per file and form (several entries may
 * share a file and form; their counts add). A count above the pin is a new site. A count below the pin, or
 * an entry for a file that is gone, fails too (shrink-only, L-202). A money site is never allowlisted
 * except as `pending:<PR>`, and the last PR of SA-1048 deletes the three `pending:*` members so the
 * compiler refuses one coming back.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const REPO_ROOT = join(__dirname, "..", "..", "..");

type Form = "F1" | "F2" | "F3" | "F4";

type Why =
  | "percent"
  | "not-money"
  | "byte-stable"
  | "stored-2dp"
  | "old-native"
  | "pending:PR-2"
  | "pending:PR-3"
  | "pending:PR-4";

interface Allow {
  file: string;
  form: Form;
  count: number;
  why: Why;
  note: string;
}

interface Hit {
  form: Form;
  index: number;
  /** F4 only: the hit sits inside a useState / setter / reset / defaultValues argument. */
  prefill: boolean;
}

// ── detector ─────────────────────────────────────────────────────────────────────────────────────────

/** Blank out comments, keeping string and template literals and the newlines (so offsets stay put). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index of the bracket that closes the one opening at `open`, or -1. */
function closeAt(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Start of the receiver expression that ends just before `dot` (the "." of `.toFixed`). */
function receiverStart(s: string, dot: number): number {
  let i = dot - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(s[i])) i--;
    if (i < 0) return 0;
    const c = s[i];
    if (c === ")" || c === "]") {
      let depth = 0;
      for (; i >= 0; i--) {
        if (s[i] === ")" || s[i] === "]") depth++;
        else if (s[i] === "(" || s[i] === "[") {
          depth--;
          if (depth === 0) break;
        }
      }
      i--;
      while (i >= 0 && /\s/.test(s[i])) i--;
      if (i >= 0 && /[\w$)\]]/.test(s[i])) continue;
      return i + 1;
    }
    if (/[\w$]/.test(c)) {
      while (i >= 0 && /[\w$]/.test(s[i])) i--;
      let j = i;
      while (j >= 0 && /\s/.test(s[j])) j--;
      if (j >= 0 && s[j] === ".") {
        i = j - 1;
        continue;
      }
      if (j >= 0 && s[j] === "?" && s[j + 1] === ".") {
        i = j - 1;
        continue;
      }
      return i + 1;
    }
    return i + 1;
  }
}

/** Is `idx` inside the argument of `useState(`, `reset(`, a `set[A-Z]...(` setter, or `defaultValues: {`? */
function inPrefill(s: string, idx: number): boolean {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = s[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (c === "(") {
        const callee = s.slice(Math.max(0, i - 60), i).match(/([A-Za-z_$][\w$]*)\s*$/);
        if (callee && /^(useState|reset|set[A-Z][\w$]*)$/.test(callee[1])) return true;
      } else if (c === "{" && /defaultValues\s*:\s*$/.test(s.slice(Math.max(0, i - 40), i))) {
        return true;
      }
    }
  }
  return false;
}

/** Every hit of the four forms in `text` (comments are stripped here). */
function detect(text: string): Hit[] {
  const s = stripComments(text);
  const hits: Hit[] = [];
  for (const m of s.matchAll(/Math\.round\s*\(/g)) {
    const index = m.index as number;
    const open = index + m[0].length - 1;
    const close = closeAt(s, open);
    if (close < 0) continue;
    const arg = s
      .slice(open + 1, close)
      .trim()
      .replace(/,$/, "")
      .trim();
    const a = arg.match(/^([\s\S]*?)\*\s*100$/);
    const b = arg.match(/^100\s*\*\s*([\s\S]*)$/);
    const e = a ? a[1].trim() : b ? b[1].trim() : null;
    if (e === null) continue;
    if (/^\s*\/\s*100(?![\w.])/.test(s.slice(close + 1))) {
      hits.push({ form: "F1", index, prefill: false });
    } else if (!/^roundMoney\s*\(/.test(e)) {
      hits.push({ form: "F3", index, prefill: false });
    }
  }
  for (const m of s.matchAll(/\.toFixed\s*\(\s*2\s*\)/g)) {
    const dot = m.index as number;
    const end = dot + m[0].length;
    const start = receiverStart(s, dot);
    const receiver = s.slice(start, dot).trim();
    const before = s.slice(0, start).replace(/\s+$/, "");
    const wrapped = /(?:\bNumber|\bparseFloat)\s*\($/.test(before) && /^\s*\)/.test(s.slice(end));
    const unaryPlus = !wrapped && /(^|[(,=:?&|!<>+\-*/%{;[]|\breturn|\bcase)\s*\+$/.test(before);
    if (wrapped || unaryPlus) {
      hits.push({ form: "F2", index: dot, prefill: false });
      continue;
    }
    const isRounded =
      /^roundMoney\s*\(/.test(receiver) &&
      closeAt(receiver, receiver.indexOf("(")) === receiver.length - 1;
    if (isRounded) continue;
    hits.push({ form: "F4", index: dot, prefill: inPrefill(s, start) });
  }
  return hits;
}

/** The hits that count toward the pin for `rel` (the F4 scope rule). */
function countedHits(rel: string, text: string): Hit[] {
  return detect(text).filter((h) => {
    if (h.form !== "F4") return true;
    if (rel.startsWith("apps/api/src/")) return true;
    return /^apps\/(web|mobile)\//.test(rel) && h.prefill;
  });
}

// ── walk ─────────────────────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  "coverage",
  ".expo",
  "__tests__",
  "e2e",
  ".git",
  "local-assets",
]);

function scanRoots(): string[] {
  const roots = ["apps/api/src", "apps/api/scripts", "apps/web", "apps/mobile", "scripts"];
  for (const p of readdirSync(join(REPO_ROOT, "packages"))) roots.push(`packages/${p}`);
  return roots.filter((r) => existsSync(join(REPO_ROOT, r)));
}

function walk(dir: string, found: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, found);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) continue;
    if (/\.(spec|test)\./.test(name) || /\.d\.ts$/.test(name)) continue;
    const rel = relative(REPO_ROOT, full).split(sep).join("/");
    if (rel.startsWith("packages/pricing/src/")) continue;
    found.push(rel);
  }
}

/** `file|form` -> hit count, over the whole tree. */
function treeCounts(): Map<string, number> {
  const files: string[] = [];
  for (const r of scanRoots()) walk(join(REPO_ROOT, r), files);
  const counts = new Map<string, number>();
  for (const rel of files) {
    for (const h of countedHits(rel, readFileSync(join(REPO_ROOT, rel), "utf8"))) {
      const key = `${rel}|${h.form}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────

const forms = (text: string, rel = "apps/api/src/x.ts"): string[] =>
  countedHits(rel, text).map((h) => h.form);

describe("detector self-test (G-1): it sees each form", () => {
  it("F1: spaced, multi-line and 100 * E", () => {
    expect(forms("const a = Math.round(x * 100) / 100;")).toEqual(["F1"]);
    expect(forms("const a = Math.round( x*100 )/100;")).toEqual(["F1"]);
    expect(forms("const a = Math.round(\n  (a + b) * 100,\n) / 100;")).toEqual(["F1"]);
    expect(forms("const a = Math.round(100 * x) / 100;")).toEqual(["F1"]);
  });

  it("F2: Number(), parseFloat() and a unary plus around toFixed(2)", () => {
    expect(forms("const a = Number(x.toFixed(2));")).toEqual(["F2"]);
    expect(forms("const a = parseFloat(x.toFixed(2));")).toEqual(["F2"]);
    expect(forms("const a = +x.toFixed(2);")).toEqual(["F2"]);
    expect(forms("const a = +(q * p).toFixed(2);")).toEqual(["F2"]);
  });

  it("F3: Math.round(E * 100) with no / 100", () => {
    expect(forms("const c = Math.round(Number(v) * 100);")).toEqual(["F3"]);
  });

  it("F4: a raw toFixed(2) in the api, and a setter or useState prefill in web and mobile", () => {
    expect(forms("const s = x.toFixed(2);")).toEqual(["F4"]);
    expect(forms("const s = Number(x).toFixed(2);")).toEqual(["F4"]);
    expect(forms("setAmount(bal.toFixed(2));", "apps/web/a.tsx")).toEqual(["F4"]);
    expect(forms("const [t, setT] = useState(p.toFixed(2));", "apps/mobile/a.tsx")).toEqual(["F4"]);
    expect(forms("reset({ amount: b.toFixed(2) });", "apps/web/a.tsx")).toEqual(["F4"]);
    expect(
      forms("useForm({ defaultValues: { amount: b.toFixed(2) } });", "apps/web/a.tsx"),
    ).toEqual(["F4"]);
  });
});

describe("detector self-test (G-1): it leaves these alone", () => {
  it("a roundMoney form, a non-cents round and a different precision", () => {
    expect(forms("const c = Math.round(roundMoney(x) * 100);")).toEqual([]);
    expect(forms("const s = roundMoney(x).toFixed(2);")).toEqual([]);
    expect(forms("const s = roundMoney(a + b).toFixed(2);")).toEqual([]);
    expect(forms("const r = Math.round(x * 1000) / 1000;")).toEqual([]);
    expect(forms("const s = x.toFixed(4);")).toEqual([]);
    expect(forms("const s = x.toFixed(1);")).toEqual([]);
  });

  it("a JSX display toFixed(2) in web or mobile (Intl-class, not a submitted value)", () => {
    expect(forms("<Text>{n.toFixed(2)}</Text>", "apps/web/a.tsx")).toEqual([]);
    expect(forms("<Text>{n.toFixed(2)}</Text>", "apps/mobile/a.tsx")).toEqual([]);
    expect(forms("const label = `$${n.toFixed(2)}`;", "apps/web/a.tsx")).toEqual([]);
  });

  it("a mention in a comment, and one inside a block comment", () => {
    expect(forms("// Math.round(x * 100) / 100 and x.toFixed(2)\nconst a = 1;")).toEqual([]);
    expect(forms("/* Number(x.toFixed(2)) */ const a = 1;")).toEqual([]);
    expect(forms("/**\n * x.toFixed(2)\n */\nconst a = 1;")).toEqual([]);
  });

  it("a comment marker inside a string does not hide the code after it", () => {
    expect(forms('const u = "http://x"; const a = Math.round(x * 100) / 100;')).toEqual(["F1"]);
  });
});

const ALLOW: Allow[] = [
  {
    file: "apps/api/scripts/billing-correct-activation.mjs",
    form: "F3",
    count: 2,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/demo-seed.js",
    form: "F3",
    count: 1,
    why: "not-money",
    note: "a customer weight for the demo picker",
  },
  {
    file: "apps/api/scripts/demo-verify.js",
    form: "F1",
    count: 2,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/lib/billing-catchup-core.cjs",
    form: "F3",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/qa-multi-seller.js",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a QA pass-rate percent",
  },
  {
    file: "apps/api/scripts/qa-run.js",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a QA pass-rate percent",
  },
  {
    file: "apps/api/scripts/report-2201-commission-sync-drift.mjs",
    form: "F1",
    count: 2,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/report-2520-first-overdue-sweep.mjs",
    form: "F1",
    count: 2,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/report-b403-zero-rate-lines.mjs",
    form: "F3",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/report-exempt-orders-taxed.mjs",
    form: "F3",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/report-order-discounts.mjs",
    form: "F3",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/report-order-taxrate-census.mjs",
    form: "F3",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/report-rf-invoice-calendar-census.mjs",
    form: "F1",
    count: 2,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/report-train4-damage.mjs",
    form: "F2",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/reset-seed.js",
    form: "F2",
    count: 5,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/sales-facts-timing.ts",
    form: "F1",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/scripts/seed-marketing-screenshot-products.js",
    form: "F1",
    count: 2,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "apps/api/src/analytics/analytics.service.ts",
    form: "F1",
    count: 1,
    why: "percent",
    note: "a margin percent",
  },
  {
    file: "apps/api/src/bookkeeping/invoice-template.tsx",
    form: "F4",
    count: 1,
    why: "not-money",
    note: "a line quantity on the printed invoice, not an amount",
  },
  {
    file: "apps/api/src/import/import.service.ts",
    form: "F4",
    count: 2,
    why: "byte-stable",
    note: "the import composite ref, stored and matched again on re-import",
  },
  {
    file: "apps/api/src/inventory/inventory.service.ts",
    form: "F1",
    count: 1,
    why: "not-money",
    note: "average daily sales in units",
  },
  {
    file: "apps/api/src/returns/returns-pieces.util.ts",
    form: "F1",
    count: 1,
    why: "not-money",
    note: "a pieces count (returns axis)",
  },
  {
    file: "apps/api/src/vendor-bills/invoice-scan.fingerprint.ts",
    form: "F4",
    count: 1,
    why: "byte-stable",
    note: "the scan fingerprint, stored and compared against later scans",
  },
  {
    file: "apps/api/src/vendor-bills/product-matcher.ts",
    form: "F1",
    count: 1,
    why: "not-money",
    note: "a product-match score",
  },
  {
    file: "apps/mobile/app/(customer)/finances.tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(customer)/shelf.tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(driver)/route/index.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "the driver's route-progress percent",
  },
  {
    file: "apps/mobile/app/(operator)/(tabs)/home.tsx",
    form: "F3",
    count: 2,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/(tabs)/invoices/[id]/payments/[paymentId]/edit.tsx",
    form: "F4",
    count: 2,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/(tabs)/invoices/[id]/record-payment.tsx",
    form: "F4",
    count: 1,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/(tabs)/warehouse.tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/payments/record.tsx",
    form: "F4",
    count: 2,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/products/[id].tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/products/index.tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/purchase-orders/[id].tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/route-runs/[id].tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(operator)/vendor-bills/scan.tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/app/(tenant)/today.tsx",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/components/CartRow.tsx",
    form: "F3",
    count: 3,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/components/InlineCreateProductSheet.tsx",
    form: "F4",
    count: 1,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/components/PosHandOverSheet.tsx",
    form: "F4",
    count: 1,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/components/RecordSupplierPaymentSheet.tsx",
    form: "F4",
    count: 2,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/components/SplitInvoiceScreen.tsx",
    form: "F1",
    count: 2,
    why: "pending:PR-4",
    note: "the driver's split-invoice preview (M1, M2)",
  },
  {
    file: "apps/mobile/components/edit-items/DraftItemCard.tsx",
    form: "F3",
    count: 3,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/components/edit-items/PriceOverrideModal.tsx",
    form: "F4",
    count: 2,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/components/edit-items/ProductPicker.tsx",
    form: "F3",
    count: 2,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/lib/buyer-finances-logic.ts",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/lib/catalog-tile-logic.ts",
    form: "F3",
    count: 1,
    why: "old-native",
    note: "an old-native percent or margin label (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/lib/credit-notes-logic.ts",
    form: "F1",
    count: 1,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/lib/sale-mode.ts",
    form: "F3",
    count: 2,
    why: "old-native",
    note: "an old-native money site; staff and buyers use the shell (owner 10-24, not changed)",
  },
  {
    file: "apps/mobile/lib/unit-options.ts",
    form: "F2",
    count: 1,
    why: "not-money",
    note: "a unit quantity label, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/analytics/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/bookkeeping/[transactionId]/page.tsx",
    form: "F1",
    count: 3,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/bookkeeping/[transactionId]/page.tsx",
    form: "F2",
    count: 2,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/credit-notes/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/credit-notes/page.tsx",
    form: "F2",
    count: 2,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/drivers/[id]/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/finance/payments/page.tsx",
    form: "F4",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/finance/reports/page.tsx",
    form: "F4",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/inventory/page.tsx",
    form: "F2",
    count: 1,
    why: "not-money",
    note: "a stock quantity after receiving, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/invoices/[id]/page.tsx",
    form: "F4",
    count: 2,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/orders/[id]/_components/own-replay.ts",
    form: "F3",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/orders/[id]/price-edit-row.tsx",
    form: "F3",
    count: 2,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/orders/_components/CounterDayClose.tsx",
    form: "F4",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/products/page.tsx",
    form: "F4",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(dashboard)/routes/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/settings/billing/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx",
    form: "F4",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(platform-admin)/admin/billing/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/(platform-admin)/admin/dashboard/page.tsx",
    form: "F3",
    count: 2,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/app/(platform-admin)/admin/dashboard/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/buyer/portal/[seller]/finances/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/buyer/portal/[seller]/shelf/page.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/buyer/portal/[seller]/shop/[productId]/_components/DetailActions.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/app/buyer/portal/[seller]/shop/_components/ProductTile.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/components/BatchItemReviewModal.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/components/InlineCreateProductModal.tsx",
    form: "F4",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/components/PriceHistory.tsx",
    form: "F3",
    count: 2,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/components/ProductCreateModal.tsx",
    form: "F4",
    count: 2,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/components/ScanInvoiceModal.tsx",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a percent label or bar width, not an amount",
  },
  {
    file: "apps/web/lib/api/credit-notes.ts",
    form: "F1",
    count: 1,
    why: "pending:PR-2",
    note: "a web money site that PR-2 converts",
  },
  {
    file: "apps/web/lib/format.ts",
    form: "F2",
    count: 1,
    why: "not-money",
    note: "formatQty: a quantity, not an amount (W10)",
  },
  {
    file: "apps/web/lib/order-qty-summary.ts",
    form: "F1",
    count: 1,
    why: "not-money",
    note: "an order quantity summary, not an amount",
  },
  {
    file: "packages/types/order-applied-credits.ts",
    form: "F3",
    count: 1,
    why: "stored-2dp",
    note: "sums stored Decimal(2) payment amounts, for which Math.round(x * 100) is exact (F-11)",
  },
  {
    file: "packages/ui/src/native/tokens.ts",
    form: "F1",
    count: 1,
    why: "not-money",
    note: "a letter-spacing in pixels",
  },
  {
    file: "scripts/campaign/plane-retro.mjs",
    form: "F1",
    count: 1,
    why: "not-money",
    note: "a ratio rounded for the retro report",
  },
  {
    file: "scripts/f07-conservation-report.mjs",
    form: "F2",
    count: 1,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "scripts/factory-eval.mjs",
    form: "F3",
    count: 1,
    why: "pending:PR-3",
    note: "an eval run cost compared in cents that PR-3 converts",
  },
  {
    file: "scripts/factory-scoreboard.mjs",
    form: "F1",
    count: 1,
    why: "pending:PR-3",
    note: "a median run cost in dollars that PR-3 converts",
  },
  {
    file: "scripts/graph.mjs",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a graph recall percent",
  },
  {
    file: "scripts/post-deploy-check.mjs",
    form: "F1",
    count: 2,
    why: "pending:PR-3",
    note: "a script money site that PR-3 converts",
  },
  {
    file: "scripts/roadmap/from-git.mjs",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a roadmap tagged-commit percent",
  },
  {
    file: "scripts/work/plane-release-sync.mjs",
    form: "F3",
    count: 1,
    why: "percent",
    note: "a release percent done",
  },
];

describe("no hand-rolled money rounding (SA-1048 G-2)", () => {
  const counts = treeCounts();
  const pinned = new Map<string, number>();
  for (const a of ALLOW) {
    const key = `${a.file}|${a.form}`;
    pinned.set(key, (pinned.get(key) ?? 0) + a.count);
  }

  it("every allowlist entry has a note, a positive count and a file that exists", () => {
    for (const a of ALLOW) {
      expect(a.note.length).toBeGreaterThan(8);
      expect(a.count).toBeGreaterThan(0);
      expect(existsSync(join(REPO_ROOT, a.file))).toBe(true);
    }
  });

  it("no site outside the allowlist, and no count above its pin (a new site)", () => {
    const over: string[] = [];
    for (const [key, n] of counts) {
      const allowed = pinned.get(key) ?? 0;
      if (n > allowed) over.push(`${key}: found ${n}, pinned ${allowed}`);
    }
    expect(over.sort()).toEqual([]);
  });

  it("no count below its pin and no entry for a site that is gone (shrink-only)", () => {
    const stale: string[] = [];
    for (const [key, allowed] of pinned) {
      const n = counts.get(key) ?? 0;
      if (n < allowed) stale.push(`${key}: pinned ${allowed}, found ${n}`);
    }
    expect(stale.sort()).toEqual([]);
  });

  it("the byte-stable sites are the three that must keep their raw toFixed(2)", () => {
    const stable = ALLOW.filter((a) => a.why === "byte-stable").map((a) => `${a.file}|${a.count}`);
    expect(stable.sort()).toEqual([
      "apps/api/src/import/import.service.ts|2",
      "apps/api/src/vendor-bills/invoice-scan.fingerprint.ts|1",
    ]);
  });

  it("apps/api/src has no money site left: only percent, not-money and byte-stable remain", () => {
    const bad = ALLOW.filter(
      (a) =>
        a.file.startsWith("apps/api/src/") &&
        !["percent", "not-money", "byte-stable"].includes(a.why),
    );
    expect(bad).toEqual([]);
  });
});
