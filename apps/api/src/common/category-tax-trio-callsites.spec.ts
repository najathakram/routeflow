/**
 * B297 (SA-088/SA-096) guard (i) — required in the PR 1+2 combined branch. Same allowlist+count-pin
 * shape as the B661 `no-second-legacy-line-pieces.spec.ts` guard: ENUMERATES every site in
 * apps/api/src that writes `categoryTaxAmount` as a line property (an OrderItem/InvoiceItem
 * money-shape marker — `categoryTaxAmount` exists on no other model), with an exact per-file
 * count pinned below. The count can only move on a deliberate edit to THIS file; a NEW site
 * (a NEW file, or a new occurrence inside an already-listed file) fails the build instead of
 * landing silently.
 *
 * Built from an independent sweep of this codebase (not taken on trust from any prior review),
 * cross-checked against a broader "does this file ALSO stamp the trio somewhere" signal
 * (`categoryTaxType` as a field name, or a call to `categoryTaxSnapshotOf`/`categoryTaxForLine` —
 * the two ways a site legitimately produces the trio: deriving it from a TrackedCategory via the
 * shared helper, or copying it verbatim from a source line's own already-stamped columns).
 *
 * KNOWN, DOCUMENTED GAPS in the pinned counts below (found by this sweep, NOT fixed by B297 —
 * flagged separately, out of scope for the rate-snapshot work):
 *   - invoices.service.ts's `recomputeOrderFromInvoices` (the invoice→order backward sync,
 *     :2367) writes `categoryTaxAmount` on a newly create()'d OrderItem (mirroring a regulated
 *     invoice line's billed tax back onto the order) WITHOUT ever setting `trackedCategoryId` on
 *     that same create() call — so a line added directly on an invoice (no matching order line)
 *     that syncs back to the order can end up with a real categoryTaxAmount but no category
 *     attribution. Filed as **B767** (filing pending in the registry batch, #1285), verified on
 *     master. Pre-existing, unrelated to the rate-snapshot trio; not fixed here — that code is
 *     being changed by Lane F's #1274, which owns the fix once #1274 merges.
 *
 * KNOWN, SAFE occurrences that legitimately do NOT stamp the trio (both counted below, neither
 * a "creator of a line with trackedCategoryId" in the sense this guard cares about):
 *   - orders.service.ts's `recomputeLineCategoryTaxes` (RE-writes an EXISTING line's amount only
 *     — reads the snapshot in PR 3, doesn't touch trackedCategoryId or the trio here).
 *   - orders.service.ts's unlisted-item branch (`trackedCategoryId: null` is a compile-time
 *     constant — an unlisted line is never a catalog product, so it can never be regulated).
 *
 * LIMIT (documented, same class as B661's own "KNOWN LIMIT"): the trio-signal check below runs
 * at FILE granularity, like the count pin itself — it cannot tell a specific NEW occurrence
 * inside an already-listed file apart from an existing one. A file whose total count doesn't
 * move is invisible to this guard even if the balance between "stamps" and "doesn't" shifted.
 * Code review covers that case; this guard's job is the ratchet — no NEW file, no NEW count.
 */
import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

const FILES = collectSourceFiles(SRC_ROOT);

// A property WRITE: `categoryTaxAmount: <expr>,` (not `: true` — a Prisma select projection —
// and not `: number` — a type declaration) or the bare shorthand `categoryTaxAmount,`.
const WRITE = /\bcategoryTaxAmount\s*(?::\s*(?!true\b)(?!number\b)\S|,)/g;
const writeCount = (text: string) => (strip(text).match(WRITE) ?? []).length;

// Either legitimate way a site produces the trio: derive via the shared helper, or copy verbatim
// from a source line's own already-stamped columns (a literal `categoryTaxType` field name, on
// either side of a `:`).
const TRIO_SIGNAL = /categoryTaxType|categoryTaxSnapshotOf|categoryTaxForLine/;
const hasTrioSignal = (text: string) => TRIO_SIGNAL.test(strip(text));

const ALLOWLIST: { file: string; count: number; note: string }[] = [
  {
    file: "orders/orders.service.ts",
    count: 3,
    note: "create() stamps; recompute (:274) and the unlisted-item branch (:1953) legitimately don't — see header",
  },
  {
    file: "orders/unit-line-build.ts",
    count: 1,
    note: "categoryTaxForLine/buildUnitLine — stamps",
  },
  {
    file: "order-templates/order-templates.service.ts",
    count: 1,
    note: "standing-order line gen — stamps",
  },
  {
    file: "invoices/invoices.service.ts",
    count: 4,
    note: "buildInvoiceItemData + duplicateInvoice stamp (update()'s moved to invoice-edit-plan.ts); recomputeOrderFromInvoices's 2 occurrences are the documented gap above",
  },
  { file: "invoices/manual-invoice-lines.ts", count: 1, note: "buildManualInvoiceLines — stamps" },
  {
    file: "invoices/invoice-edit-plan.ts",
    count: 2,
    note: "buildEditedLines stamp + inPlacePatch (writes only a CHANGED amount)",
  },
  { file: "invoices/invoice-unit-line.ts", count: 1, note: "buildInvoiceUnitLine — stamps" },
];

describe("category tax trio callsites — every categoryTaxAmount writer enumerated (B297-SPEC.md guard i, SA-096)", () => {
  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("the write fingerprint sees colon-value and shorthand forms, and excludes select-projections and type declarations", () => {
    expect(writeCount("categoryTaxAmount: amount,")).toBe(1);
    expect(writeCount("categoryTaxAmount,")).toBe(1);
    expect(writeCount("categoryTaxAmount: true,")).toBe(0); // Prisma select projection
    expect(writeCount("categoryTaxAmount: number;")).toBe(0); // type declaration
    expect(writeCount("// categoryTaxAmount: amount,")).toBe(0); // comment stripped first
  });

  it("every allowlisted file's write count is EXACTLY what's pinned — never higher (a new site), never lower (a stale, shrunk entry)", () => {
    for (const { file, count } of ALLOWLIST) {
      const text = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
      expect({ file, count: writeCount(text) }).toEqual({ file, count });
    }
  });

  it("every allowlisted file also carries the trio-derivation signal at least once", () => {
    for (const { file } of ALLOWLIST) {
      const text = fs.readFileSync(path.join(SRC_ROOT, file), "utf8");
      expect({ file, hasSignal: hasTrioSignal(text) }).toEqual({ file, hasSignal: true });
    }
  });

  it("no file OUTSIDE the allowlist writes categoryTaxAmount — a NEW creator fails the build, not just a changed one", () => {
    const allowedFiles = new Set(ALLOWLIST.map((a) => a.file));
    const offenders = FILES.filter((f) => {
      const rel = path.relative(SRC_ROOT, f).replace(/\\/g, "/");
      if (allowedFiles.has(rel)) return false;
      return writeCount(fs.readFileSync(f, "utf8")) > 0;
    }).map((f) => path.relative(SRC_ROOT, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });

  it("total categoryTaxAmount writes across apps/api/src is exactly 13", () => {
    const total = FILES.reduce((n, f) => n + writeCount(fs.readFileSync(f, "utf8")), 0);
    expect(total).toBe(13);
  });
});
