import * as fs from "fs";
import * as path from "path";

/**
 * SA-1102 PR-A §2.3 (S-6): a BUSINESS Anthropic key (SystemConfig `anthropic.apiKey`) is for bill scans only. The key
 * is read by exactly two production files: the vendor-bill scan (which passes it to `prepareAiCall` for the
 * `bill_scan` task) and the tenant settings endpoint (which shows and saves it). A receipt, statement or route-insight
 * call that read it again would spend a client's key on a job it was never meant for, so a third reader fails here.
 */
const SRC = path.join(__dirname, "..");
const KEY = /["']anthropic\.apiKey["']/g;

// file -> number of literal mentions
const ALLOWED: Record<string, number> = {
  // SECRET_KEYS member (encrypted at rest)
  "system-config/system-config.service.ts": 1,
  // GET (read) + PATCH (clear / save): the business's own key card
  "system-config/settings.controller.ts": 2,
  // VendorBillsService.scanInvoice: the one scan that may use a business key
  "vendor-bills/vendor-bills.service.ts": 1,
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("business Anthropic key readers (SA-1102 S-6)", () => {
  it("only the bill scan and the tenant settings card mention the business key", () => {
    const found: Record<string, number> = {};
    for (const file of walk(SRC)) {
      const r = path.relative(SRC, file).split(path.sep).join("/");
      if (r.endsWith(".spec.ts") || r.includes("/testing/")) continue;
      const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const n = (text.replace(/(^|[^:])\/\/.*$/gm, "$1").match(KEY) ?? []).length;
      if (n > 0) found[r] = n;
    }
    expect(found).toEqual(ALLOWED);
  });

  it("the vendor-bill scan hands the key to the resolver for the bill_scan task only", () => {
    const text = fs.readFileSync(path.join(SRC, "vendor-bills/vendor-bills.service.ts"), "utf8");
    expect(text).toMatch(/prepareAiCall\(\s*"bill_scan"\s*,\s*\w*[Kk]ey/);
  });

  it.each([
    "bookkeeping/bookkeeping.service.ts",
    "supplier-statements/supplier-statements.service.ts",
    "route-optimization/route-analysis.service.ts",
  ])("%s resolves its key by task alone (no business key argument)", (file) => {
    const text = fs.readFileSync(path.join(SRC, file), "utf8");
    const calls = text.match(/prepareAiCall\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/^prepareAiCall\(\s*"\w+"\s*\)$/);
  });
});
