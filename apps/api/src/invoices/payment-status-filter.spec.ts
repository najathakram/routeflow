/**
 * PR-2 (check-payments B1 hardening) — static guard modeled on
 * `common/no-bare-cron.spec.ts`: a hand-rolled "not VOID" filter on
 * `InvoicePayment` is exactly the historical (buggy) shorthand
 * `payment-confirmation.ts` documents as the source of B11/B57/B74/B81/B84/
 * B85/B97/B102/B103 — it silently counts a DRAFT row. Every such site must
 * either route through a shared predicate/helper from `@routeflow/pricing`
 * (`isBlockingPayment`/`BLOCKING_PAYMENT`/`remainingCapacity`) or carry a
 * `scan-ok: draft-payment-not-void` comment within a few lines, pre-marking
 * it as an intentional, non-money-leak use (a listing filter, an existence/
 * dedup candidate list, a same-row/single-row CAS guard, or the internal
 * query that feeds `remainingCapacity` itself).
 *
 * MODEL-AWARE: the literal pattern `status !== "VOID"` / `status: { not:
 * "VOID" }` also occurs on CreditNote, VendorBill, Invoice, and
 * CommissionStatement rows — models with their own, unrelated status
 * machinery that coincidentally share the string "VOID". Flagging those
 * would make this spec useless noise, so a candidate site is only an
 * "offender" when it looks like it is reading an `InvoicePayment` row: the
 * Prisma receiver is `invoicePayment.` (or a `payments:` relation
 * where/include), or the property-access receiver is a payment-shaped
 * variable name (`p`, `pmt`, `payment`, `bounced`, or `.payments` element).
 * Anything reading a `.creditNote`/`.vendorBill`/`.invoice`/
 * `.commissionStatement`/`.supplier`/`.order` receiver, or an obviously
 * non-payment variable (`c`, `cn`, `bill`, `b`, `inv`, `invoice`, `order`), is
 * out of scope for this spec — those files' own domains own that filter.
 * An ambiguous site (neither list matches) fails CLOSED (treated as a
 * payment site) so a genuinely new shape gets a human's classification
 * instead of silently passing.
 *
 * PATTERN COVERAGE (PR-2 review, routeflow-Lead, 2026-09-16): catches both
 * `status: { not: ... }` and `status: { notIn: [...] }` Prisma filters, both
 * the string literal `"VOID"` and the `PaymentStatus.VOID` enum member, both
 * `!==`/`!=` comparisons, and REVERSED operand order (`"VOID" !== p.status`).
 * A comment merely mentioning a shared-predicate name does not exempt a
 * candidate — only an actual CODE line using it does; a `scan-ok` marker,
 * being itself always written as a comment, is still read from comments.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const FILES = collectSourceFiles(SRC_ROOT);

// The two ways a VOID value can be spelled in this codebase.
const VOID_LIT = `(?:"VOID"|PaymentStatus\\.VOID)`;

// Prisma model receivers with their OWN status machinery that happens to
// share the literal "VOID" — a match on one of these lines (or the nearest
// preceding model-receiver line, when the filter itself spans lines) is out
// of scope for this spec.
const OTHER_MODEL_RECEIVER =
  /\.(creditNote|creditNoteItem|vendorBill|commissionStatement|supplier|order)\.\s*(findMany|findFirst|findUnique|aggregate|update|updateMany|count|create|groupBy)\s*\(/;
// `tx.invoice.` / `db.invoice.` / `this.prisma.forTenant().invoice.` etc — the
// Invoice model's OWN status (DRAFT/SENT/VOID/PAID/...), not a payment's.
const INVOICE_MODEL_RECEIVER =
  /\.invoice\.\s*(findMany|findFirst|findUnique|update|updateMany|count)\s*\(/;
const PAYMENT_MODEL_RECEIVER =
  /\.invoicePayment\.\s*(findMany|findFirst|findUnique|update|updateMany|count|aggregate)\s*\(/;
// A `payments:` relation key in a Prisma where/include — always InvoicePayment.
const PAYMENTS_RELATION_KEY = /\bpayments\s*:\s*\{/;

// Variable-name receivers known to be a different model's already-fetched row
// (never an InvoicePayment) vs. known to be an InvoicePayment row — checked in
// BOTH operand orders (`x.status !== VOID` and `VOID !== x.status`) and with
// both `!==` and `!=`.
const OTHER_MODEL_VARS = ["c", "cn", "bill", "b", "inv", "invoice", "order"];
const PAYMENT_VARS = ["p", "pmt", "payment", "bounced"];

function varReceiverPattern(names: string[]): RegExp {
  const alt = names.join("|");
  return new RegExp(
    `(?:\\b(?:${alt})\\.status\\s*!==?\\s*${VOID_LIT}` +
      `|${VOID_LIT}\\s*!==?\\s*(?:${alt})\\.status\\b)`,
  );
}
const OTHER_MODEL_VAR_RECEIVER = varReceiverPattern(OTHER_MODEL_VARS);
const PAYMENT_VAR_RECEIVER = varReceiverPattern(PAYMENT_VARS);

// Prisma filter form: `status: { not: "VOID" }` / `status: { notIn: ["VOID"] }`,
// either VOID spelling, with or without a trailing `as any`.
const NOT_VOID_FILTER = new RegExp(
  `status\\s*:\\s*\\{\\s*(?:not:\\s*${VOID_LIT}(?:\\s+as\\s+any)?` +
    `|notIn:\\s*\\[\\s*${VOID_LIT}\\s*\\](?:\\s+as\\s+any)?)\\s*\\}`,
);
// Property-comparison form, either operand order, `!==` or `!=`.
const NOT_VOID_COMPARISON_FWD = new RegExp(`\\.status\\s*!==?\\s*${VOID_LIT}`);
const NOT_VOID_COMPARISON_REV = new RegExp(`${VOID_LIT}\\s*!==?\\s*[\\w$]+\\??\\.status\\b`);

const SCAN_OK_MARKER = /scan-ok:\s*draft-payment-not-void/;
const SHARED_PREDICATE_USE = /\b(isBlockingPayment|BLOCKING_PAYMENT|remainingCapacity)\b/;

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

interface Candidate {
  file: string;
  line: number;
  text: string;
}

interface Offender extends Candidate {
  reason: string;
}

function isOtherModel(lines: string[], idx: number): boolean {
  // Look at the current line and up to 4 lines above for the nearest model
  // receiver — Prisma where-clauses commonly split the receiver call and the
  // `status` key across lines.
  for (let i = idx; i >= Math.max(0, idx - 4); i--) {
    if (PAYMENT_MODEL_RECEIVER.test(lines[i]) || PAYMENTS_RELATION_KEY.test(lines[i])) return false;
    if (OTHER_MODEL_RECEIVER.test(lines[i]) || INVOICE_MODEL_RECEIVER.test(lines[i])) return true;
  }
  return false;
}

/**
 * A `scan-ok` marker is itself always written as a comment, so it is read
 * from ANY nearby line including comments. A shared-predicate NAME, on the
 * other hand, only exempts a candidate when it appears in real code — a
 * comment that merely mentions `remainingCapacity` in prose (e.g. explaining
 * why a site does NOT use it) must not silently exempt anything.
 */
function hasNearbyMarkerOrSharedUse(lines: string[], idx: number): boolean {
  const start = Math.max(0, idx - 10);
  const end = Math.min(lines.length - 1, idx + 1);
  for (let i = start; i <= end; i++) {
    if (SCAN_OK_MARKER.test(lines[i])) return true;
    if (!COMMENT_LINE.test(lines[i]) && SHARED_PREDICATE_USE.test(lines[i])) return true;
  }
  return false;
}

function scanFile(file: string): { candidates: Candidate[]; offenders: Offender[] } {
  const rel = path.relative(SRC_ROOT, file).replace(/\\/g, "/");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const candidates: Candidate[] = [];
  const offenders: Offender[] = [];

  lines.forEach((line, idx) => {
    // A comment merely DESCRIBING the pattern in prose (e.g. this very file's own header, or an
    // inline note like invoices.service.ts's "sweep's single-status `status: { not: "VOID" }`
    // pattern...") is not code and must never be treated as a candidate site.
    if (COMMENT_LINE.test(line)) return;
    const isFilter = NOT_VOID_FILTER.test(line);
    const isComparison = NOT_VOID_COMPARISON_FWD.test(line) || NOT_VOID_COMPARISON_REV.test(line);
    if (!isFilter && !isComparison) return;

    if (isComparison && OTHER_MODEL_VAR_RECEIVER.test(line) && !PAYMENT_VAR_RECEIVER.test(line)) {
      return; // e.g. `c.status !== "VOID"`, `cn.status !== "VOID"` — CreditNote, not InvoicePayment.
    }
    if (isFilter && isOtherModel(lines, idx)) {
      return; // e.g. `tx.creditNote.findMany({ where: { status: { not: "VOID" } } })`.
    }

    const candidate: Candidate = { file: rel, line: idx + 1, text: line.trim() };
    candidates.push(candidate);
    if (!hasNearbyMarkerOrSharedUse(lines, idx)) {
      offenders.push({
        ...candidate,
        reason:
          "InvoicePayment 'not VOID' filter with no scan-ok marker and no shared predicate use",
      });
    }
  });

  return { candidates, offenders };
}

describe("no un-marked hand-rolled InvoicePayment not-VOID filters (PR-2, model-aware)", () => {
  const results = FILES.map((f) => ({
    file: path.relative(SRC_ROOT, f).replace(/\\/g, "/"),
    ...scanFile(f),
  }));

  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("actually finds InvoicePayment not-VOID candidates (a regex matching nothing would report green)", () => {
    const total = results.reduce((n, r) => n + r.candidates.length, 0);
    expect(total).toBeGreaterThan(5);
  });

  it("correctly excludes the known other-model sites (CreditNote/VendorBill/Invoice) as out of scope", () => {
    const creditNotes = results.find((r) =>
      r.file.endsWith("credit-notes/credit-notes.service.ts"),
    );
    expect(creditNotes).toBeDefined();
    const text = fs.readFileSync(
      path.join(SRC_ROOT, "credit-notes", "credit-notes.service.ts"),
      "utf8",
    );
    const rawMatches =
      (text.match(new RegExp(NOT_VOID_FILTER.source, "g"))?.length ?? 0) +
      (text.match(new RegExp(NOT_VOID_COMPARISON_FWD.source, "g"))?.length ?? 0) +
      (text.match(new RegExp(NOT_VOID_COMPARISON_REV.source, "g"))?.length ?? 0);
    // credit-notes.service.ts has several `tx.creditNote.findMany({ where: { status: { not:
    // "VOID" } } })` / `cn.status !== "VOID"` sites (CreditNote's OWN status) alongside its
    // InvoicePayment sites — the exclusion logic must actually drop the CreditNote ones, not
    // just happen to find zero candidates overall.
    expect(rawMatches).toBeGreaterThan(creditNotes!.candidates.length);
    expect(creditNotes!.candidates.length).toBeGreaterThan(0);
  });

  it("does not let a comment mentioning a shared-predicate name exempt a real candidate", () => {
    // A candidate line followed only by a comment that NAMES remainingCapacity/
    // isBlockingPayment in prose (never used in code) must still be flagged.
    const lines = [
      "// this deliberately does not use remainingCapacity here",
      'const nonVoid = payments.filter((p) => p.status !== "VOID");',
    ];
    const offenders: string[] = [];
    lines.forEach((line, idx) => {
      if (COMMENT_LINE.test(line)) return;
      const isComparison = NOT_VOID_COMPARISON_FWD.test(line) || NOT_VOID_COMPARISON_REV.test(line);
      if (!isComparison) return;
      if (!hasNearbyMarkerOrSharedUse(lines, idx)) offenders.push(line);
    });
    expect(offenders).toHaveLength(1);
  });

  it('catches notIn/PaymentStatus.VOID/reversed-operand/!= shapes, not just `status !== "VOID"`', () => {
    const shapes = [
      'const x = payments.filter((p) => p.status !== "VOID");',
      'const x = payments.filter((p) => p.status != "VOID");',
      'const x = payments.filter((p) => "VOID" !== p.status);',
      "const x = payments.filter((p) => p.status !== PaymentStatus.VOID);",
      'db.invoicePayment.findMany({ where: { status: { not: "VOID" } } });',
      'db.invoicePayment.findMany({ where: { status: { notIn: ["VOID"] } } });',
      "db.invoicePayment.findMany({ where: { status: { notIn: [PaymentStatus.VOID] } } });",
    ];
    for (const line of shapes) {
      const isFilter = NOT_VOID_FILTER.test(line);
      const isComparison = NOT_VOID_COMPARISON_FWD.test(line) || NOT_VOID_COMPARISON_REV.test(line);
      expect(isFilter || isComparison).toBe(true);
    }
  });

  it("has zero un-marked InvoicePayment not-VOID sites", () => {
    const offenders = results
      .flatMap((r) => r.offenders)
      .map((o) => `${o.file}:${o.line} — ${o.text}`);

    expect(offenders).toEqual([]);
  });
});
