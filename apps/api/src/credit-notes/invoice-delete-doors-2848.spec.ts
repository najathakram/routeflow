/**
 * #2848 (SA-608e/f) - static guard: every place that can delete an Invoice row is a KNOWN door.
 *
 * A credit note's `invoiceId` is nulled by the FK (SET NULL) when its invoice is deleted, which
 * orphans it silently. Every door that can orphan a note must therefore call
 * `unlinkSourcedCredits` (sourced-credit-guard.ts), which reads the note ids first and leaves one
 * SOURCE_DELETED AuditLog row per note; the reissue and the PATCH-expiry refuse such notes.
 *
 * The scan walks `apps/api/src` (spec files excluded, comments stripped) for, per file:
 *   - `.invoice.delete(` / `.invoice.deleteMany(`, whitespace/newline tolerant, and the bracket form
 *     `["invoice"].delete(`;
 *   - a raw `DELETE FROM "Invoice"`;
 *   - an ALIAS of the delegate (`const inv = tx.invoice;`, `const { invoice } = tx`), after which
 *     `inv.delete(` would slip past the call patterns.
 * It FAILS on any hit outside KNOWN_DOORS or whose count changed. A new door needs a row here AND a
 * call to `unlinkSourcedCredits` (or a stated reason it cannot orphan a surviving note).
 */

import * as fs from "fs";
import * as path from "path";
import { stripComments } from "../common/testing/unscoped-write-scan";

const SRC_ROOT = path.resolve(__dirname, "..");

const WS = String.raw`\s*`;
const DELEGATE = String.raw`(?:\.${WS}invoice|\[${WS}["'\`]invoice["'\`]${WS}\])`;
const DELETE_CALL = new RegExp(
  String.raw`${DELEGATE}${WS}\.${WS}(?:delete|deleteMany)${WS}\(`,
  "g",
);
const RAW_DELETE = /DELETE\s+FROM\s+"?Invoice"?\b/gi;
const ALIAS = new RegExp(
  String.raw`=${WS}[\w.$]+${WS}${DELEGATE}${WS}[;,)]|\{[^}]*\binvoice\b[^}]*\}${WS}=${WS}(?:tx|this\.prisma|prisma|db|this\.db)\b`,
  "g",
);

/** How many delete-capable Invoice references a source text contains (comments ignored). */
export function scanInvoiceDeletes(src: string): number {
  const code = stripComments(src);
  return [DELETE_CALL, RAW_DELETE, ALIAS].reduce(
    (n, re) => n + (code.match(new RegExp(re.source, re.flags)) ?? []).length,
    0,
  );
}

/**
 * The text of `async <name>(` up to the next method at the same indent (2 spaces), or "". A
 * module-level `export async function <name>(` (a door extracted out of a service) is found too, up
 * to its closing `}` at column 0.
 */
export function methodBody(src: string, name: string): string {
  const method = src.indexOf(`  async ${name}(`);
  if (method !== -1) {
    const end = src.indexOf("\n  }\n", method);
    return end === -1 ? src.slice(method) : src.slice(method, end);
  }
  const fn = src.indexOf(`export async function ${name}(`);
  if (fn === -1) return "";
  const end = src.indexOf("\n}\n", fn);
  return end === -1 ? src.slice(fn) : src.slice(fn, end);
}

type Door = {
  count: number;
  /** "wired": `inside` calls unlinkSourcedCredits. "pending": wired in a follow-up commit, tracked by ticket + expiry. "no-orphan": cannot orphan a surviving note. */
  kind: "wired" | "pending" | "no-orphan";
  why: string;
  inside?: string; // wired: the method that must contain the call
  ticket?: string; // pending: required
  pendingUntil?: string; // pending: required ISO date, must still be in the future
};

const KNOWN_DOORS: Record<string, Door> = {
  "invoices/invoices.service.ts": {
    count: 1,
    kind: "wired",
    inside: "deleteInvoice",
    why: "deleteInvoice",
  },
  // Row 259: deleteOrder's invoice loop and the merge-loser draft delete both go through this one helper.
  "orders/order-invoice-delete.ts": {
    count: 1,
    kind: "wired",
    inside: "deleteOrderInvoice",
    why: "deleteOrder's invoice loop + the merge-loser draft delete (orders.service.ts has no delete of its own)",
  },
  "customers/customer-delete-preflight.ts": {
    count: 1,
    kind: "no-orphan",
    why: "customer hard-delete: the customer's own credit notes are refused (or deleted) in the same flow (#2587/SA-516)",
  },
  "system-config/settings.controller.ts": {
    count: 1,
    kind: "no-orphan",
    why: "tenant data wipe: credit notes are deleted in the same transaction",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

describe("invoice delete doors (#2848)", () => {
  const found = new Map<string, number>();
  for (const file of walk(SRC_ROOT)) {
    const n = scanInvoiceDeletes(fs.readFileSync(file, "utf8"));
    if (n > 0) found.set(path.relative(SRC_ROOT, file).split(path.sep).join("/"), n);
  }

  it("every invoice delete sits in a known door, with the expected count", () => {
    const actual = Object.fromEntries([...found].sort());
    const expected = Object.fromEntries(
      Object.entries(KNOWN_DOORS)
        .sort()
        .map(([f, d]) => [f, d.count]),
    );
    expect(actual).toEqual(expected);
  });

  it("every 'wired' door calls unlinkSourcedCredits INSIDE its named method", () => {
    for (const [file, door] of Object.entries(KNOWN_DOORS)) {
      if (door.kind !== "wired") continue;
      const body = methodBody(fs.readFileSync(path.join(SRC_ROOT, file), "utf8"), door.inside!);
      expect(body).toContain("unlinkSourcedCredits(");
    }
  });

  it("pending doors are tracked: a ticket, and an expiry that is still in the future", () => {
    // Row 259 wired the last pending door, so the list may be empty; any new "pending" entry is checked here.
    const pending = Object.entries(KNOWN_DOORS).filter(([, d]) => d.kind === "pending");
    for (const [file, d] of pending) {
      expect(`${file} ${d.ticket}`).toMatch(/ #\d+$/);
      const until = Date.parse(`${d.pendingUntil}T00:00:00Z`);
      expect(Number.isNaN(until)).toBe(false);
      // Expired debt fails the build: wire the door, or consciously re-date it with the owner.
      expect(Date.now()).toBeLessThan(until);
    }
  });
});

/** Each way a delete could hide is proven by a mutant: the scanner must see it. */
describe("scanInvoiceDeletes mutants (#2848)", () => {
  it.each([
    ["a plain call", "await tx.invoice.delete({ where: { id } });"],
    ["deleteMany", "await tx.invoice.deleteMany({ where: { tenantId } });"],
    ["a call split across lines", "await tx.invoice\n    .delete({ where: { id } });"],
    ["a space before the dot and paren", "await tx.invoice . deleteMany ({});"],
    ["the bracket form", 'await tx["invoice"].delete({ where: { id } });'],
    ["raw SQL", 'await tx.$executeRaw`DELETE FROM "Invoice" WHERE id = ${id}`;'],
    ["raw SQL, lower case", 'await q("delete from invoice where id = 1");'],
    ["an alias", "const inv = tx.invoice;\nawait inv.delete({ where: { id } });"],
    ["a destructured alias", "const { invoice } = tx;\nawait invoice.delete({ where: { id } });"],
  ])("sees %s", (_name, src) => {
    expect(scanInvoiceDeletes(src)).toBeGreaterThan(0);
  });

  it.each([
    ["a read", "await tx.invoice.findUnique({ where: { id } });"],
    ["a commented-out delete", "// await tx.invoice.delete({ where: { id } });"],
    ["a block-commented delete", "/* tx.invoice.deleteMany({}) */ const a = 1;"],
    ["another model", "await tx.invoiceItem.deleteMany({ where: { invoiceId } });"],
    ["a credit note delete", "await tx.creditNote.delete({ where: { id } });"],
  ])("ignores %s", (_name, src) => {
    expect(scanInvoiceDeletes(src)).toBe(0);
  });

  it("methodBody isolates one method, so a call elsewhere in the file does not count", () => {
    const src =
      "  async a() {\n    x();\n  }\n\n  async b() {\n    unlinkSourcedCredits(1);\n  }\n";
    expect(methodBody(src, "b")).toContain("unlinkSourcedCredits(");
    expect(methodBody(src, "a")).not.toContain("unlinkSourcedCredits(");
  });

  it("methodBody isolates a module-level exported function the same way", () => {
    const src =
      "export async function a(tx: any) {\n  x();\n}\n\nexport async function b(tx: any) {\n  unlinkSourcedCredits(1);\n}\n";
    expect(methodBody(src, "b")).toContain("unlinkSourcedCredits(");
    expect(methodBody(src, "a")).not.toContain("unlinkSourcedCredits(");
  });
});
