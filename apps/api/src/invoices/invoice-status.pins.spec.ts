/**
 * SA-763r P-3 [L-O1] / [L-O2] structural pins (B1098): the status-from-payments rule lives in ONE body,
 * `statusFromPayments` (invoices/invoice-status.ts), and an overpaid invoice is never PAID unless a caller
 * deliberately says so.
 *
 *  1. every call states `onOverpaid` as a literal ("NOT_PAID" | "PAID"); the old name is gone;
 *  2. the literal `"PAID"` appears at EXACTLY ONE call site: the operator's standalone overpayment
 *     (recordStandalonePayment), which also writes the `invoice.deliberate-overpayment` audit row;
 *  3. no other code derives an invoice PAID from a paid-vs-total comparison. The allow-list is the
 *     two derivations that cannot restate an issued invoice: the historical-data import (the source
 *     system's own status) and bookkeeping's recordPayment (the payment is capped at the remaining balance
 *     before it is written, so it cannot overpay). A new entry needs a stated reason.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..");
const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      return e.name === "node_modules" || e.name === "testing" ? [] : walk(path.join(dir, e.name));
    }
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)
      ? [path.join(dir, e.name)]
      : [];
  });
}
const sources = walk(SRC).map((file) => ({
  rel: path.relative(SRC, file).replace(/\\/g, "/"),
  src: strip(fs.readFileSync(file, "utf8")),
}));

/** The top-level argument texts of every `statusFromPayments(` CALL (the import/definition excluded). */
function statusCalls(src: string): Array<{ args: string[]; at: number }> {
  const out: Array<{ args: string[]; at: number }> = [];
  const re = /\bstatusFromPayments\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    const args: string[] = [];
    let cur = "";
    let quote: string | null = null;
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i];
      if (quote) {
        cur += ch;
        if (ch === "\\") cur += src[++i];
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        cur += ch;
        continue;
      }
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      if (depth === 0) break;
      if (ch === "," && depth === 1) {
        args.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) args.push(cur.trim());
    out.push({ args, at: m.index });
  }
  return out;
}

describe("statusFromPayments: one body, one deliberate PAID caller (SA-763r P-3)", () => {
  it("the old name is gone everywhere", () => {
    expect(
      sources.filter((s) => /\brecomputeInvoiceStatus\b/.test(s.src)).map((s) => s.rel),
    ).toEqual([]);
  });

  it("every call passes onOverpaid (6th argument) as a string literal", () => {
    const bad: string[] = [];
    for (const { rel, src } of sources) {
      if (rel === "invoices/invoice-status.ts") continue;
      for (const c of statusCalls(src)) {
        if (!/^["'](NOT_PAID|PAID)["']$/.test(c.args[5] ?? "")) bad.push(`${rel}@${c.at}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the literal "PAID" is passed at exactly ONE call site: recordStandalonePayment', () => {
    const paid: string[] = [];
    for (const { rel, src } of sources) {
      for (const c of statusCalls(src)) {
        if (/^["']PAID["']$/.test(c.args[5] ?? "")) {
          const upto = src.slice(0, c.at);
          const heads = [...upto.matchAll(/^ {2}(?:private |public )?(?:async )?(\w+)\(/gm)];
          paid.push(`${rel}#${heads[heads.length - 1]?.[1]}`);
        }
      }
    }
    expect(paid).toEqual(["invoices/invoices.service.ts#recordStandalonePayment"]);
    // and that site writes the audit row in the same transaction
    const svc = sources.find((s) => s.rel === "invoices/invoices.service.ts")!.src;
    const at = svc.indexOf("async recordStandalonePayment(");
    const body = svc.slice(at, svc.indexOf("\n  }\n", at));
    expect(body).toContain("auditDeliberateOverpayment(");
  });

  it("no code outside invoice-status.ts derives PAID from a paid-vs-total comparison", () => {
    const DERIVES = /(?:>=|>)[^;{}]{0,80}?(?:\?|\)\s*\w+\s*=)\s*InvoiceStatus\.PAID/;
    const ALLOWED: Record<string, string> = {
      "import/import-payment-status.ts":
        "imported historical invoices take the source system's own settled state; no order edit reaches them",
      "bookkeeping/bookkeeping.service.ts":
        "recordPayment refuses an amount above the remaining balance before it writes, so it cannot overpay",
    };
    const found = sources
      .filter((s) => s.rel !== "invoices/invoice-status.ts" && DERIVES.test(s.src))
      .map((s) => s.rel)
      .sort();
    expect(found).toEqual(Object.keys(ALLOWED).sort());
  });
});
