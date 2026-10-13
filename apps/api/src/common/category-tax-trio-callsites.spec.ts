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
 *   - orders/recompute-line-category-taxes.ts (B297 PR3; was orders.service.ts's
 *     `recomputeLineCategoryTaxes`): RE-writes an EXISTING line's amount from the line's own
 *     snapshot, and stamps the trio only on a NULL-trio line (once, `recomputeCategoryTax`'s
 *     `stamp`); the count includes its member read `li.categoryTaxAmount` (storedAmount).
 *   - invoices/price-adjustment-ledger.ts's buildPriceAdjustmentUpdates (B297 PR3): the count is its
 *     member read `item.categoryTaxAmount` (storedAmount); the write is `data.categoryTaxAmount =`,
 *     which the fingerprint does not see, and the stamp is `Object.assign(data, r.stamp)`.
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
    note: "create() stamps; the unlisted-item branch legitimately doesn't; the pack-line substitute writes categoryTaxAmount: 0 beside its re-stamped trio (B297 PR3; the recompute moved to recompute-line-category-taxes.ts) — see header",
  },
  {
    file: "orders/recompute-line-category-taxes.ts",
    count: 3,
    note: "B297 PR3: snapshot recompute — 2 writes (amount; amount + stamped trio on a NULL-trio line) + the storedAmount member read",
  },
  {
    file: "invoices/price-adjustment-ledger.ts",
    count: 1,
    note: "B297 PR3: the storedAmount member read; the write is data.categoryTaxAmount = (+ Object.assign stamp) — see header",
  },
  {
    file: "orders/unit-line-edit.ts",
    count: 2,
    note: "B297 row 338: updateUnitLine's destructure + its SUBSTITUTE-only data spread (a same-product edit writes no category, levy or trio; the new product's are stamped only on a substitute)",
  },
  {
    file: "orders/carry-line-category.ts",
    count: 1,
    note: "B297 row 340: carriedCategory — a fold's no-category line carries its STORED levy (never a computed one); a full trio carries the line's own trio, copied not derived",
  },
  {
    file: "orders/replace-all-line-build.ts",
    count: 2,
    note: "B297 row 340: both matches are on the existing-line map entry (the `categoryTaxAmount:` key and the `li.categoryTaxAmount,` member read); the carry itself is carriedCategory in carry-line-category.ts",
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
    count: 3,
    note: "buildEditedLines stamp + the B297 PR3 matched-row storedAmount read + inPlacePatch (writes only a CHANGED amount)",
  },
  { file: "invoices/invoice-unit-line.ts", count: 1, note: "buildInvoiceUnitLine — stamps" },
  {
    file: "invoices/partial-price-follow.ts",
    count: 5,
    note: "SA-760 Q-760-1 price follow (the fingerprint also counts the member reads f.categoryTaxAmount / it.categoryTaxAmount): copies the amount and the trio verbatim from the shared builder's output for a stale DRAFT-partial line (categoryTaxType et al. in the same write); no derivation of its own",
  },
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

  it("total categoryTaxAmount writes across apps/api/src is exactly 28", () => {
    const total = FILES.reduce((n, f) => n + writeCount(fs.readFileSync(f, "utf8")), 0);
    expect(total).toBe(28);
  });
});
