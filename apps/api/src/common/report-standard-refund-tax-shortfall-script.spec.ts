import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SA-840 §5 owner-run report (apps/api/scripts/report-standard-refund-tax-shortfall.mjs): READ ONLY, tenant ids and
 * counts only, behind the live-target guard. Run under jest.scripts.config.js.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-standard-refund-tax-shortfall.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FAKE_URL = "postgresql://u:secret@db.example.test:5432/railway";

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.DATABASE_URL;
  for (const k of Object.keys(e)) if (k.startsWith("RAILWAY_")) delete e[k];
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...e, ...env } as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
}
const fail = (r: ReturnType<typeof run>) =>
  `status=${r.status} signal=${r.signal} error=${r.error?.message ?? "none"}\nstderr: ${r.stderr}\nstdout: ${String(r.stdout).slice(0, 400)}`;

/**
 * `priceReturn` is the pure pricing of the report. It lives in an .mjs that imports the compiled pricing package, so it
 * is driven in a child node (the same way the script itself runs) with JSON in and out; `credits` is rebuilt as a Map there.
 */
function priceInChild(input: {
  ret: { creditNoteId: string | null; refundedAt: string };
  items: Array<{ productId: string; qty: string }>;
  invoices: unknown[];
  credits?: Record<string, unknown[]>;
}) {
  const program = `
    import { pathToFileURL } from "node:url";
    const { priceReturn } = await import(pathToFileURL(${JSON.stringify(SCRIPT)}).href);
    const i = ${JSON.stringify(input)};
    const credits = new Map(Object.entries(i.credits ?? {}));
    process.stdout.write(JSON.stringify(priceReturn(i.ret, i.items, { invoices: i.invoices, credits })));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: API_DIR,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(fail(r as ReturnType<typeof run>));
  return JSON.parse(r.stdout) as {
    net: number;
    tax: number;
    categoryTax: number;
    discounted: boolean;
  } | null;
}

// the SAME fixtures and hand-verified figures as packages/pricing/src/refundable-line-share.spec.ts (SA-970), so the
// report and the mint (refundableProductPoolShare) are pinned to one set of numbers
const line = (id: string, subtotal: number, qty: number, taxRate = 0.08, levy = 0) => ({
  id,
  productId: "p",
  qty: String(qty),
  subtotal: String(subtotal),
  taxRate: String(taxRate),
  categoryTaxAmount: String(levy),
  isNsf: false,
});
const RET = { creditNoteId: "cn-this", refundedAt: "2026-09-10T00:00:00Z" };
const ITEM = (qty: number) => [{ productId: "p", qty: String(qty) }];

describe("SA-970 the report prices a product-only return item over the product pool, like the mint", () => {
  // paid line 10 pcs at 100.00 + free line 2 pcs, 8%: pool 12 pieces, net 100.00, tax 8.00
  const promo = () => ({
    id: "i1",
    taxAmount: "8",
    discount: "0",
    lines: [line("paid", 100, 10), line("free", 0, 2)],
  });
  // two lines of one product at different prices, 8%: pool net 150.00, tax 12.00 over 2 pieces
  const split = () => ({
    id: "i1",
    taxAmount: "12",
    discount: "0",
    lines: [line("dear", 100, 1), line("cheap", 50, 1)],
  });

  it("(b) a cheap and a dear line of one product: 1 of 2 pieces is 75.00 + 6.00, not the per-line 100.00 + 8.00", () => {
    const out = priceInChild({ ret: RET, items: ITEM(1), invoices: [split()] });
    expect(out).toEqual({ net: 75, tax: 6, categoryTax: 0, discounted: false });
  });

  it("(a) 11 of a 12-piece pool (10 paid + 2 free): 91.67 + 7.33, not the per-line 100.00 + 8.00", () => {
    const out = priceInChild({ ret: RET, items: ITEM(11), invoices: [promo()] });
    expect(out).toEqual({ net: 91.67, tax: 7.33, categoryTax: 0, discounted: false });
  });

  it("the pool telescopes on the credit EARLIER than refundedAt: the last piece of the pool is 8.33 + 0.67", () => {
    const earlier = { creditNoteId: "cn-old", at: "2026-09-01T00:00:00Z" };
    const out = priceInChild({
      ret: RET,
      items: ITEM(1),
      invoices: [promo()],
      credits: {
        paid: [{ ...earlier, qty: "10", amount: "91.67", categoryTax: "0" }],
        free: [{ ...earlier, qty: "1", amount: "0", categoryTax: "0" }],
      },
    });
    expect(out).toEqual({ net: 8.33, tax: 0.67, categoryTax: 0, discounted: false });
  });

  it("a pool of one line is the per-line slice (R1: 5 of 10 is 25 / 2 / 5)", () => {
    const r1 = { id: "i1", taxAmount: "14", discount: "0", lines: [line("l1", 50, 10, 0.08, 10)] };
    const out = priceInChild({ ret: RET, items: ITEM(5), invoices: [r1] });
    expect(out).toEqual({ net: 25, tax: 2, categoryTax: 5, discounted: false });
  });
});

describe("SA-840 standard-refund tax shortfall report", () => {
  it("--self-test exits 0 (pricing, bucket fold, own over-credit column, read-only wrapper, guard, args)", () => {
    const r = run(["--self-test"]);
    expect({ ok: r.status === 0, detail: r.status === 0 ? "" : fail(r) }).toEqual({
      ok: true,
      detail: "",
    });
  });

  it("issues no write verb and no raw execute: the file is plain reads", () => {
    expect(code).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX)\b/i,
    );
    expect(code).not.toMatch(/\$executeRaw|\$queryRaw|\.execute\(|PrismaClient|writeFile\(/);
    // the only file it writes is the CSV under local-assets/handoff
    expect(code.match(/writeFileSync\(/g)).toHaveLength(1);
    expect(src).toContain('"local-assets"');
    expect(src).toContain('"handoff"');
  });

  it("opens a READ ONLY session, proves it with SHOW transaction_read_only (exit 2), and rolls back", () => {
    expect(src).toContain("SET default_transaction_read_only = on");
    expect(src).toContain("BEGIN READ ONLY");
    expect(src).toContain("SHOW transaction_read_only");
    expect(src).toContain("exitCode = 2");
    expect(src).toContain('"ROLLBACK"');
    expect(src).toContain("./lib/report-db-url.mjs");
    expect(code).not.toMatch(/\bDATABASE_URL\b/);
  });

  it("prices through the compiled pricing package, never its own slice math", () => {
    expect(src).toMatch(/from "@routeflow\/pricing"/);
    // SA-970: the mint prices a product-only return item over the product POOL, so the report must too
    expect(code).toContain("refundableProductPoolShare(");
    expect(code).not.toContain("refundableLineShare(");
    expect(code).toContain("sumInvoiceTotals(");
    expect(code).not.toMatch(/billedSubtotal|creditedThrough\(|computeLineSubtotal/);
  });

  it("selects no customer, name, slug or document-number column, and outputs only the SA-840 columns", () => {
    const sql = [...code.matchAll(/const Q_\w+ = `([\s\S]*?)`;/g)].map((m) => m[1]).join("\n");
    expect(sql).toContain('FROM "Return"');
    expect(sql).not.toMatch(
      /customerId|businessName|slug|returnNumber|invoiceNumber|creditNoteNumber|email|"name"/,
    );
    const columns = /export const COLUMNS = \[([\s\S]*?)\];/.exec(code)?.[1] ?? "";
    expect([...columns.matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([
      "tenantId",
      "month",
      "method",
      "returns",
      "creditNotes",
      "missingRegularTax",
      "missingCategoryTax",
      "netOverCreditUnsharedDiscount",
      "invoicesTaxDiffersFromPools",
      "unpriced",
    ]);
  });

  it("refuses before connecting: exit 64 without --target-host, 65 on a wrong host, never prints the password", () => {
    const missing = run([], { DATABASE_URL: FAKE_URL });
    expect({ status: missing.status, leaked: missing.stderr.includes("secret") }).toEqual({
      status: 64,
      leaked: false,
    });
    expect(missing.stderr).toContain("db.example.test");
    const wrong = run(["--target-host=other.example.test"], { DATABASE_URL: FAKE_URL });
    expect(wrong.status).toBe(65);
  });

  it("has no write flag, and --tenant takes ids only", () => {
    for (const bad of [["--apply"], ["--fix"], ["--repair"], ["--tenant", "acme"], ["--tenant"]]) {
      const r = run(bad, { DATABASE_URL: FAKE_URL });
      expect({ args: bad, status: r.status }).toEqual({ args: bad, status: 2 });
    }
  });

  it("fails closed (non-zero) when no database is configured, before any connection", () => {
    expect(run([]).status).not.toBe(0);
  });
});
