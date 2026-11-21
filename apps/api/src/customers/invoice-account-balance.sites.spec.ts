import * as fs from "fs";
import * as path from "path";

/**
 * SA-1197 G4 / C5 / C12: the account block has ONE reader and ONE row builder, called from a known set of sites, and
 * its words live only in the label map (and the api's pinned mirror). A new caller, or a renderer that spells a label,
 * fails here: it must go through the leaf, so every figure stays the statement's figure.
 */
const REPO = path.resolve(__dirname, "..", "..", "..", "..");
const API_SRC = path.join(REPO, "apps", "api", "src");
const LEAF = path.join("customers", "invoice-account-balance.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "__mocks__", ".next", "dist"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.(spec|test)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const count = (src: string, re: RegExp) => (strip(src).match(re) ?? []).length;

describe("invoice account block sites (SA-1197)", () => {
  it("the reader and the row builder are called only from the pinned sites", () => {
    const calls: Record<string, number> = {};
    for (const f of walk(API_SRC)) {
      const rel = path.relative(API_SRC, f).split(path.sep).join("/");
      if (rel === LEAF.split(path.sep).join("/")) continue;
      const n = count(
        fs.readFileSync(f, "utf8"),
        /\b(readInvoiceAccountBalance|accountBlockRows|detailAccountBlock)\s*\(/g,
      );
      if (n > 0) calls[rel] = n;
    }
    expect(calls).toEqual({
      "invoices/invoice-pdf.service.ts": 2, // a download reads for itself; the rows once
      "invoices/invoice-email-payload.ts": 1, // the rows of the handed result
      "invoices/invoices.service.ts": 2, // the send's ONE read (C4) and the detail read
    });
  });

  it("no renderer or other file spells a block label (C12)", () => {
    const LABELS = /Your account on|Other unpaid invoices|Open balance on/;
    const allowed = new Set([
      path.join(API_SRC, LEAF),
      path.join(REPO, "packages", "types", "api", "invoice-account.ts"),
    ]);
    const roots = [
      API_SRC,
      path.join(REPO, "apps", "web", "app"),
      path.join(REPO, "apps", "web", "components"),
      path.join(REPO, "apps", "web", "lib"),
      path.join(REPO, "packages", "types"),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const f of walk(root)) {
        if (allowed.has(f)) continue;
        if (LABELS.test(strip(fs.readFileSync(f, "utf8")))) offenders.push(path.relative(REPO, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the renderers print rows as given: no block word in the PDF template, the email or the web view", () => {
    const renderers = [
      path.join(API_SRC, "invoices", "invoice-pdf-template.tsx"),
      path.join(API_SRC, "email", "email.service.ts"),
      path.join(
        REPO,
        "apps",
        "web",
        "app",
        "(dashboard)",
        "invoices",
        "[id]",
        "InvoiceTotalsSummary.tsx",
      ),
      // read B L1: the settings preview reads the map too, so a typed short label there goes red
      path.join(
        REPO,
        "apps",
        "web",
        "app",
        "(dashboard)",
        "settings",
        "_components",
        "InvoiceLayoutPreview.tsx",
      ),
    ];
    for (const f of renderers) {
      const src = strip(fs.readFileSync(f, "utf8"));
      expect([f, /["'`>]\s*(This invoice|Open balance)\s*["'`<]/.test(src)]).toEqual([f, false]);
    }
  });
});

describe("one account read per send (SA-1197 C4, T3)", () => {
  const service = fs.readFileSync(path.join(API_SRC, "invoices", "invoices.service.ts"), "utf8");
  const a = service.indexOf("private async deliverEmail(");
  const deliver = service.slice(a, service.indexOf("this.gateway.emitInvoiceUpdated(", a));

  it("deliverEmail reads the account once, from the snapshot, and hands the same object to the PDF and the payload", () => {
    expect(a).toBeGreaterThan(-1);
    expect(deliver.match(/readInvoiceAccountBalance\(/g)).toHaveLength(1);
    expect(deliver).toMatch(
      /const account = await acct\.readInvoiceAccountBalance\(this\.prisma, snapshot, layout\)/,
    );
    expect(deliver).toMatch(/getOrGenerate\(id, \{ variant, model: snapshot, account \}\)/);
    expect(deliver).toMatch(/buildInvoiceEmailPayload\(snapshot, \{[\s\S]*?\baccount,[\s\S]*?\}\)/);
    // the read comes before the PDF is built
    expect(deliver.indexOf("readInvoiceAccountBalance(")).toBeLessThan(
      deliver.indexOf("getOrGenerate("),
    );
  });
});

/**
 * SA-1197 A2-2: every caller of the invoice PDF (getOrGenerate / generateAndUpload) with its account policy.
 *   handed     - passes the one account read it made (the send, C4)
 *   show:false - passes { show: false }, so the PDF prints no block and reads nothing (the reminder, C13)
 *   reads      - passes no account; the PDF reads the block itself when the switch is on
 * A new caller fails here until it is listed with its policy.
 */
describe("invoice PDF callers and their account policy (SA-1197 A2-2)", () => {
  // delta-1 L1: ?. calls, chains split over lines and .bind aliases count too
  const CALL = /([\w.]+)\??\s*\.\s*(getOrGenerate|generateAndUpload)\b/g;
  const policyOf = (args: string) =>
    /\baccount:\s*\{\s*show:\s*false\s*\}/.test(args)
      ? "show:false"
      : /\baccount\s*(?:[,})]|:\s*(?!undefined\b|null\b)\w)/.test(args) // L2: account: undefined reads
        ? "handed"
        : "reads";

  it("lists every caller with its policy", () => {
    const found: Record<string, string[]> = {};
    for (const f of walk(API_SRC)) {
      const rel = path.relative(API_SRC, f).split(path.sep).join("/");
      const src = strip(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(CALL)) {
        if (/statementPdf/i.test(m[1])) continue; // the statement PDF is another service
        // the call's arguments run to the end of its statement
        const at = (m.index ?? 0) + m[0].length;
        const end = src.indexOf(";", at);
        (found[rel] ??= []).push(policyOf(src.slice(at, end > -1 ? end : src.length)));
      }
    }
    expect(found).toEqual({
      "invoices/invoice-pdf.service.ts": ["handed"], // its own getOrGenerate -> generateAndUpload hop forwards opts.account
      "invoices/invoices.service.ts": ["handed"], // the send: ONE read for the PDF and the email (C4)
      "invoices/invoice-reminder-email.ts": ["show:false"], // C13: the reminder carries none
      "invoices/invoices.controller.ts": ["reads"], // the staff download
      "buyer/buyer.controller.ts": ["reads"], // the buyer detail's PDF (its extra read: LATER, PR-2)
      "bookkeeping/bookkeeping.service.ts": ["reads"], // the bookkeeping download
      "invoices/invoice-completion-email.ts": ["reads"], // the completion email's attached PDF prints the block
    });
  });
});
