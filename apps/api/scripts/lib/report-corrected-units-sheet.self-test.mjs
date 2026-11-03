/**
 * No-database checks of report-corrected-units-sheet's pure part (SA-1088 rows QD-2, QD-4 to QD-8). Fixtures only:
 * `assembleSheet` is fed the shape `buildLineContexts` returns. Throws on the first failure.
 */
import assert from "node:assert/strict";
import * as lib from "./report-corrected-units-sheet.mjs";

// written after the B661 cutoff would read as piece-axis; before it, a box-count row (unitBasisQty = qty) is legacy
const BEFORE_CUTOFF = "2026-09-01T00:00:00Z";
const CAT = "cat1";
const MONTH_START = new Date("2026-07-01T00:00:00Z");
const MONTH_END = new Date("2026-08-01T00:00:00Z");

const row = (o) => ({
  id: "r",
  entryType: "SALE",
  qty: 5,
  unitBasisQty: 5,
  netSales: 100,
  categoryTax: 10,
  soldAt: BEFORE_CUTOFF,
  periodBucket: "2026-07",
  correctsEntryId: null,
  returnId: null,
  creditNoteId: null,
  createdAt: BEFORE_CUTOFF,
  writtenAt: BEFORE_CUTOFF,
  ...o,
});
// the live InvoiceItem a box-count copy is checked against: 5 boxes of 12 = 60 pieces, so the pack is 12
const SOURCE = { id: "ii1", qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12 };
const line = (key, rows, o = {}) => ({
  lineKey: key,
  tenantId: "t",
  trackedCategoryId: CAT,
  orderItemId: "oi1",
  productId: "p",
  productPackNow: 12,
  inGeneratedFiling: false,
  line: {
    boxes: null,
    pieces: null,
    unitLabel: null,
    unitsPerBox: null,
    which: "orderItem",
    qty: 5,
  },
  rows,
  ...o,
});
const contextsOf = (entries) => ({
  lines: new Map(entries.map((e) => [`${e.trackedCategoryId}|${e.lineKey}`, e])),
  candidatesByOrderItem: new Map([["oi1", [SOURCE]]]),
  returnItemsByPair: new Map(),
  attributionByPair: new Map(),
  priorByCorrectedRow: new Map(),
  rowsWithExistingCorrection: new Set(),
});
const filing = (o) => ({
  id: "f",
  trackedCategoryId: CAT,
  periodKey: "2026-07",
  periodStart: MONTH_START,
  periodEnd: MONTH_END,
  status: "GENERATED",
  generatedAt: "2026-08-02T00:00:00Z",
  lockedAt: null,
  rows: [{ trackedCategoryId: CAT, periodBucket: "2026-07", unitBasisQty: 5 }],
  ...o,
});
const refs = new Map([["l1", { docKind: "invoice", docNo: "INV-1", ordinal: 1, sku: "SKU-1" }]]);
const sums = (n) => [{ trackedCategoryId: CAT, periodBucket: "2026-07", unit_basis_sum: n }];
const boxLine = () => line("l1", [row({ id: "s1" })]);

export async function selfTest() {
  // QD-4: the ledger sum equals the snapshot -> RECONCILED; the corrected total is snapshot + the line deltas
  const ok = lib.assembleSheet({
    contexts: contextsOf([boxLine()]),
    refs,
    filings: [filing({})],
    periodSums: sums(5),
  });
  assert.equal(ok.lineRows.length, 1);
  assert.deepEqual(
    [
      ok.lineRows[0].category,
      ok.lineRows[0].packFactor,
      ok.lineRows[0].ledgerUnitBasis,
      ok.lineRows[0].correctedUnitBasis,
      ok.lineRows[0].delta,
    ],
    ["A", 12, 5, 60, 55],
    "a box-axis line is corrected to boxes x pack",
  );
  assert.equal(ok.lineRows[0].lineRef, "invoice INV-1 line 1");
  assert.equal(ok.lineRows[0].product, "SKU-1");
  assert.deepEqual(
    [
      ok.periods[0].status,
      ok.periods[0].snapshotUnitBasisQty,
      ok.periods[0].lineDeltaSum,
      ok.periods[0].correctedTotal,
    ],
    ["RECONCILED", 5, 55, 60],
  );
  assert.equal(ok.summary.exitCode, 0);

  // QD-5: the ledger moved since filing -> named, exit 1, corrected total still snapshot + line deltas (never the live sum)
  const moved = lib.assembleSheet({
    contexts: contextsOf([boxLine()]),
    refs,
    filings: [filing({})],
    periodSums: sums(7),
  });
  assert.equal(moved.periods[0].status, "LEDGER MOVED SINCE FILING");
  assert.equal(moved.periods[0].movedBy, 2);
  assert.equal(moved.periods[0].correctedTotal, 60);
  assert.equal(moved.summary.exitCode, 1);
  assert.match(lib.footerLines(moved).join("\n"), /LEDGER MOVED SINCE FILING by 2/);

  // QD-6: straddling and unknown-basis lines are listed, corrected column empty, reason given
  const straddle = line("l2", [row({ id: "a" }), row({ id: "b", qty: 2, unitBasisQty: 24 })]);
  const unknown = line("l3", [row({ id: "c" })], { productPackNow: undefined, orderItemId: null });
  const mixed = lib.assembleSheet({
    contexts: contextsOf([boxLine(), straddle, unknown]),
    refs,
    filings: [filing({})],
    periodSums: sums(5),
  });
  for (const key of ["l2", "l3"]) {
    const r = mixed.lineRows.find((x) => x.lineKey === key);
    assert.ok(r, `${key} is listed`);
    assert.equal(r.correctedUnitBasis, null);
    assert.equal(r.delta, null);
    assert.ok(r.reason.length > 0, "a reason is given");
  }
  assert.equal(mixed.lineRows.find((x) => x.lineKey === "l2").category, "straddles");
  assert.equal(mixed.lineRows.find((x) => x.lineKey === "l3").category, "unknown-basis");
  assert.equal(mixed.periods[0].uncorrectedLines, 2);
  // a clean piece-axis line is absent
  const clean = line("l4", [row({ id: "d", qty: 5, unitBasisQty: 60 })]);
  assert.equal(
    lib.assembleSheet({ contexts: contextsOf([clean]), refs, filings: [], periodSums: [] }).lineRows
      .length,
    0,
  );
  // a line carrying correction rows is listed unclassified, never guessed
  const withCorrection = line("l5", [
    row({ id: "e" }),
    row({ id: "f", correctsEntryId: "e", qty: 0, unitBasisQty: 55 }),
  ]);
  const shaped = lib.assembleSheet({
    contexts: contextsOf([withCorrection]),
    refs,
    filings: [],
    periodSums: [],
  });
  assert.equal(shaped.summary.newShapeLines, 1);
  assert.equal(shaped.lineRows[0].correctedUnitBasis, null);

  // QD-7: two filings for one period -> all listed; compared with the newest LOCKED, else the newest GENERATED
  const gen1 = filing({
    id: "g1",
    generatedAt: "2026-08-02T00:00:00Z",
    rows: [{ trackedCategoryId: CAT, periodBucket: "2026-07", unitBasisQty: 4 }],
  });
  const gen2 = filing({
    id: "g2",
    generatedAt: "2026-08-09T00:00:00Z",
    periodKey: "2026-Q3",
    periodEnd: new Date("2026-10-01T00:00:00Z"),
    rows: [{ trackedCategoryId: CAT, periodBucket: "2026-07", unitBasisQty: 5 }],
  });
  const lockedOld = filing({
    id: "l1",
    status: "LOCKED",
    lockedAt: "2026-08-05T00:00:00Z",
    rows: [{ trackedCategoryId: CAT, periodBucket: "2026-07", unitBasisQty: 6 }],
  });
  const failed = filing({
    id: "x",
    status: "FAILED",
    generatedAt: "2026-08-20T00:00:00Z",
    rows: [],
  });
  const two = lib.assembleSheet({
    contexts: contextsOf([boxLine()]),
    refs,
    filings: [gen1, gen2],
    periodSums: sums(5),
  });
  assert.equal(two.periods[0].filings.length, 2, "both listed");
  assert.deepEqual(
    [
      two.periods[0].comparedWith.status,
      two.periods[0].comparedWith.periodKey,
      two.periods[0].snapshotUnitBasisQty,
      two.periods[0].status,
    ],
    ["GENERATED", "2026-Q3", 5, "RECONCILED"],
  );
  const withLocked = lib.assembleSheet({
    contexts: contextsOf([boxLine()]),
    refs,
    filings: [gen1, gen2, lockedOld, failed],
    periodSums: sums(5),
  });
  assert.equal(
    withLocked.periods[0].comparedWith.status,
    "LOCKED",
    "the LOCKED one wins even though older",
  );
  assert.equal(withLocked.periods[0].snapshotUnitBasisQty, 6);
  assert.equal(
    withLocked.periods[0].filings.length,
    3,
    "a FAILED attempt is not a filing of the period",
  );
  // no filing covers the period -> NOT FILED, not an error; a covering filing with no snapshot row -> exit 1
  assert.deepEqual(
    [
      lib.assembleSheet({
        contexts: contextsOf([boxLine()]),
        refs,
        filings: [],
        periodSums: sums(5),
      }).periods[0].status,
    ],
    ["NOT FILED"],
  );
  const txShape = lib.assembleSheet({
    contexts: contextsOf([boxLine()]),
    refs,
    filings: [filing({ rows: { txRows: [] } })],
    periodSums: sums(5),
  });
  assert.deepEqual([txShape.periods[0].status, txShape.summary.exitCode], ["NO SNAPSHOT ROW", 1]);

  // QD-8: any count other than 49 is printed loudly
  assert.equal(ok.summary.countMismatch, true);
  assert.match(
    lib.summaryLines(ok).join("\n"),
    /!!! LINE COUNT 1 IS NOT THE 49 OF THE SA-790 CENSUS/,
  );
  const fortyNine = Array.from({ length: 49 }, (_, i) => line(`k${i}`, [row({ id: `row${i}` })]));
  const full = lib.assembleSheet({
    contexts: contextsOf(fortyNine),
    refs,
    filings: [],
    periodSums: [],
  });
  assert.equal(full.summary.countMismatch, false);
  assert.doesNotMatch(lib.summaryLines(full).join("\n"), /!!!/);
  assert.equal(lib.formatCsv(ok, { generatedAt: "t" }).split("\n")[0], `# ${lib.REFERENCE_NOTE}`);

  // instants are read as UTC in SQL, never in the client's zone (a non-UTC owner machine shifts filing windows and the B661 cutoff)
  assert.match(lib.FILINGS_SQL, /"periodStart" AT TIME ZONE 'UTC'/);
  assert.match(lib.FILINGS_SQL, /"generatedAt" AT TIME ZONE 'UTC'/);

  // QD-2: write-shaped flags are refused; one tenant per run
  for (const f of lib.WRITE_FLAGS)
    assert.equal(lib.checkArgs(["--tenant", "test", f]).ok, false, f);
  assert.equal(lib.checkArgs([]).ok, false, "a tenant is required");
  assert.equal(lib.checkArgs(["--tenant", "test", "--tenant", "x"]).tenant, "x");
  assert.equal(
    lib.checkArgs(["--tenant", "test", "--target-host=db.example.test"]).targetHost,
    "db.example.test",
  );
  assert.equal(lib.checkArgs(["--tenant", "test", "--wat"]).ok, false);
  assert.equal(lib.guardTenant("test", false).ok, true);
  assert.equal(lib.guardTenant("acme", false).ok, false, "a non-test slug needs the override");
  assert.deepEqual(lib.guardTenant("acme", true), { ok: true, live: true });

  // the host guard (exit 64 missing, 65 mismatch) and the READ ONLY wrapper
  const t = lib.targetOf("postgresql://u:p%40ss@db.example.test:5432/railway");
  assert.deepEqual([t.host, t.database], ["db.example.test", "railway"]);
  assert.equal(JSON.stringify(t).includes("p%40ss"), false);
  assert.equal(lib.guardTarget(null, t).code, 64);
  assert.equal(lib.guardTarget("prod.example.test", t).code, 65);
  assert.equal(lib.guardTarget("db.example.test", t).ok, true);
  const seen = [];
  const client = {
    query: async (sql) => (
      seen.push(sql),
      sql === lib.SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "on" }] } : { rows: [] }
    ),
  };
  await lib.withReadOnlyTx(client, async () => {});
  assert.equal(seen[0], "SET default_transaction_read_only = on");
  assert.deepEqual([seen.includes(lib.BEGIN_READ_ONLY), seen.at(-1)], [true, "ROLLBACK"]);
  let aborted = false;
  await lib
    .withReadOnlyTx(
      {
        query: async (sql) =>
          sql === lib.SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "off" }] } : { rows: [] },
      },
      async () => {},
    )
    .catch(() => (aborted = true));
  assert.equal(aborted, true, "aborts when the transaction is not read-only");

  // HOLD 1 (review-a and review-b on #4140): a line whose return-driven reversal the classifier refused to prove
  // (no unique ReturnItem) has NO corrected figure. The classifier would add the SALE in pieces (60) to a reversal
  // still in boxes (-2) and print 58; a read-only sheet parks nothing, so it lists the line unguessed instead.
  const returnDriven = (extra = {}) =>
    row({
      id: "v1",
      entryType: "REVERSAL",
      qty: -2,
      unitBasisQty: -2,
      netSales: -40,
      categoryTax: -4,
      returnId: "ret1",
      ...extra,
    });
  const unproven = lib.assembleSheet({
    contexts: contextsOf([line("l1", [row({ id: "s1" }), returnDriven()])]),
    refs,
    filings: [
      filing({ rows: [{ trackedCategoryId: CAT, periodBucket: "2026-07", unitBasisQty: 3 }] }),
    ],
    periodSums: sums(3),
  });
  assert.equal(unproven.lineRows.length, 1);
  assert.equal(
    unproven.lineRows[0].correctedUnitBasis,
    null,
    "no figure for an unproven return reversal",
  );
  assert.equal(unproven.lineRows[0].delta, null);
  assert.match(unproven.lineRows[0].reason, /could not be proven/);
  assert.doesNotMatch(
    unproven.lineRows[0].reason,
    /parked for architect/,
    "this sheet parks nothing",
  );
  assert.equal(unproven.periods[0].uncorrectedLines, 1, "counted as uncorrected in the footer");
  assert.equal(unproven.periods[0].lineDeltaSum, 0);
  assert.equal(
    unproven.periods[0].correctedTotal,
    3,
    "the footer total does not take a guessed figure",
  );
  assert.match(lib.footerLines(unproven).join(" | "), /excludes 1/);
  // control: the same reversal as a credit note IS provable and keeps its figure (36 = 3 boxes x 12)
  const viaCreditNote = lib.assembleSheet({
    contexts: contextsOf([
      line("l1", [row({ id: "s1" }), returnDriven({ returnId: null, creditNoteId: "cn1" })]),
    ]),
    refs,
    filings: [
      filing({ rows: [{ trackedCategoryId: CAT, periodBucket: "2026-07", unitBasisQty: 3 }] }),
    ],
    periodSums: sums(3),
  });
  assert.equal(viaCreditNote.lineRows[0].correctedUnitBasis, 36);

  // HOLD 2 (review-a): one line key in two categories is two lines, each classified on its own rows
  const inCat = (cat, rows) => line("l1", rows, { trackedCategoryId: cat });
  const split = lib.assembleSheet({
    contexts: contextsOf([
      inCat("catA", [
        row({ id: "a1" }),
        row({ id: "a2", entryType: "REVERSAL", qty: -5, unitBasisQty: -5 }),
      ]),
      inCat("catB", [row({ id: "b1" })]),
    ]),
    refs,
    filings: [],
    periodSums: [],
  });
  const byCat = (c) => split.lineRows.filter((r) => r.categoryId === c);
  assert.deepEqual(
    byCat("catA").map((r) => r.correctedUnitBasis),
    [0],
  );
  assert.deepEqual(
    byCat("catB").map((r) => r.correctedUnitBasis),
    [60],
  );
  assert.deepEqual(split.periods.map((p) => [p.categoryId, p.lineDeltaSum]).sort(), [
    ["catA", 0],
    ["catB", 55],
  ]);

  // review-a note 3: a key holding only REVERSAL rows is listed, never dropped
  const orphan = lib.assembleSheet({
    contexts: contextsOf([
      line("l1", [row({ id: "r1", entryType: "REVERSAL", qty: -2, unitBasisQty: -2 })]),
    ]),
    refs,
    filings: [],
    periodSums: [],
  });
  assert.equal(orphan.lineRows.length, 1, "a reversal-only line is listed");
  assert.equal(orphan.lineRows[0].correctedUnitBasis, null);
  assert.match(orphan.lineRows[0].reason, /no sale row/i);

  // review-a hold 3, the window and the filing's category: a July filing is not compared with August, and another
  // category's filing is not this category's
  const aug = lib.assembleSheet({
    contexts: contextsOf([line("l1", [row({ id: "s9", periodBucket: "2026-08" })])]),
    refs,
    filings: [filing({})],
    periodSums: [{ trackedCategoryId: CAT, periodBucket: "2026-08", unit_basis_sum: 5 }],
  });
  assert.equal(aug.periods[0].status, "NOT FILED", "the July window ends before 2026-08-01");
  const otherCat = lib.assembleSheet({
    contexts: contextsOf([boxLine()]),
    refs,
    filings: [filing({ trackedCategoryId: "catB" })],
    periodSums: sums(5),
  });
  assert.equal(
    otherCat.periods[0].status,
    "NOT FILED",
    "another category's filing is not compared",
  );
  return "self-test ok";
}

if (process.argv[1] && process.argv[1].endsWith("report-corrected-units-sheet.self-test.mjs")) {
  selfTest().then(console.log, (e) => {
    console.error(e.message);
    process.exit(1);
  });
}
