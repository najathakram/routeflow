/**
 * #2848 (SA-608e) - static guard: every place that deletes an Invoice row is a KNOWN door.
 *
 * A credit note's `invoiceId` is nulled by the FK (SET NULL) when its invoice is deleted, which
 * orphans it silently. Every door that can orphan a note must therefore call
 * `unlinkSourcedCredits` (sourced-credit-guard.ts), which reads the note ids first and leaves one
 * SOURCE_DELETED AuditLog row per note; the reissue and the PATCH-expiry refuse such notes.
 *
 * This walks `apps/api/src` for `.invoice.delete(` / `.invoice.deleteMany(` (spec files excluded)
 * and FAILS on any delete that is not listed below, or whose count in a listed file changed. A new
 * door needs a row here AND a call to `unlinkSourcedCredits` (or a stated reason it cannot orphan).
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const DELETE_CALL = /\.invoice\.(delete|deleteMany)\(/g;

type Door = {
  count: number;
  /** "wired": the file calls unlinkSourcedCredits. "pending": wired in #2848 commit 2 (after U-units). "no-orphan": cannot orphan a surviving note. */
  kind: "wired" | "pending" | "no-orphan";
  why: string;
};

const KNOWN_DOORS: Record<string, Door> = {
  "invoices/invoices.service.ts": {
    count: 1,
    kind: "wired",
    why: "deleteInvoice",
  },
  "orders/orders.service.ts": {
    count: 2,
    kind: "pending",
    why: "deleteOrder's invoice loop + the merge-loser draft delete (implicit FK SET NULL); wired in #2848 commit 2 once U-units' #2784/#2786 land",
  },
  "customers/customer-delete-preflight.ts": {
    count: 1,
    kind: "no-orphan",
    why: "customer hard-delete: the customer's own credit notes are deleted or refused in the same flow (#2587/SA-516)",
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
    const n = (fs.readFileSync(file, "utf8").match(DELETE_CALL) ?? []).length;
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

  it("every 'wired' door calls unlinkSourcedCredits", () => {
    for (const [file, door] of Object.entries(KNOWN_DOORS)) {
      if (door.kind !== "wired") continue;
      expect(fs.readFileSync(path.join(SRC_ROOT, file), "utf8")).toContain("unlinkSourcedCredits(");
    }
  });

  it("a 'pending' door is an explicit, dated debt: it must go green -> wired in commit 2", () => {
    const pending = Object.entries(KNOWN_DOORS).filter(([, d]) => d.kind === "pending");
    expect(pending.map(([f]) => f)).toEqual(["orders/orders.service.ts"]);
  });
});
