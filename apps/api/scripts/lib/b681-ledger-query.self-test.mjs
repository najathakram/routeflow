#!/usr/bin/env node
// Self-test for b681-ledger-query.mjs's pure query-shaping functions -- the omitted-vs-null
// productPackNow convention and the pack/return evidence pickers. Fixtures only -- no
// database connection. Run directly: `node apps/api/scripts/lib/b681-ledger-query.self-test.mjs`.
import assert from "node:assert/strict";
import {
  BOX_UNAWARE_ROWS_SQL,
  groupByLineKey,
  pickSourceLine,
  pickReturnItem,
  buildReturnEvidence,
  rowEvidence,
} from "./b681-ledger-query.mjs";

let pass = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

// --- groupByLineKey: productPackNow omitted (no Product row) vs explicit null -------------------

t(
  "groupByLineKey: product_found=false -> productPackNow is OMITTED (undefined), never null",
  () => {
    const lines = groupByLineKey([
      {
        line_key: "li1",
        tenantId: "t1",
        trackedCategoryId: "cat1",
        orderItemId: "oi1",
        product_id: "deleted-product",
        product_found: false,
        product_pack_now: null,
        line_boxes: null,
        line_pieces: null,
        line_unit_label: null,
        line_units_per_box: null,
        which_line: "orderItem",
        line_qty: "5",
        in_generated_filing: false,
        id: "row1",
        entryType: "SALE",
        qty: "5",
        unitBasisQty: "60",
        netSales: "100.00",
        categoryTax: "8.00",
        soldAt: "2026-01-01",
        periodBucket: "2026-01",
        correctsEntryId: null,
        returnId: null,
        creditNoteId: null,
        createdAt: "2026-01-01",
      },
    ]);
    const entry = lines.get("cat1|li1");
    assert.equal(entry.productPackNow, undefined);
    assert.equal("productPackNow" in entry, true, "the key must exist and be exactly undefined");
  },
);

// one line key under two categories is two lines (the ledger's own key includes the category), never one line
// carrying the first row's category
t(
  "groupByLineKey: the same line key in two categories is two entries, each with its own rows",
  () => {
    const base = {
      line_key: "li9",
      tenantId: "t1",
      orderItemId: "oi9",
      product_id: "p1",
      product_found: true,
      product_pack_now: 12,
      line_boxes: null,
      line_pieces: null,
      line_unit_label: null,
      line_units_per_box: null,
      which_line: "orderItem",
      line_qty: "10",
      in_generated_filing: false,
      entryType: "SALE",
      qty: "10",
      unitBasisQty: "10",
      netSales: "1",
      categoryTax: "0",
      soldAt: "2026-01-01",
      periodBucket: "2026-01",
      correctsEntryId: null,
      returnId: null,
      creditNoteId: null,
      createdAt: "2026-01-01",
    };
    const lines = groupByLineKey([
      { ...base, id: "a1", trackedCategoryId: "catA" },
      {
        ...base,
        id: "a2",
        trackedCategoryId: "catA",
        entryType: "REVERSAL",
        qty: "-10",
        unitBasisQty: "-10",
      },
      { ...base, id: "b1", trackedCategoryId: "catB" },
    ]);
    assert.equal(lines.size, 2);
    assert.deepEqual(
      lines.get("catA|li9").rows.map((r) => r.id),
      ["a1", "a2"],
    );
    assert.deepEqual(
      lines.get("catB|li9").rows.map((r) => r.id),
      ["b1"],
    );
    assert.equal(lines.get("catB|li9").trackedCategoryId, "catB");
    assert.equal(lines.get("catB|li9").lineKey, "li9");
  },
);

t("groupByLineKey: product_found=true, unitsPerBox null -> productPackNow is explicit null", () => {
  const lines = groupByLineKey([
    {
      line_key: "li2",
      tenantId: "t1",
      trackedCategoryId: "cat1",
      orderItemId: "oi2",
      product_id: "p1",
      product_found: true,
      product_pack_now: null,
      line_boxes: null,
      line_pieces: null,
      line_unit_label: null,
      line_units_per_box: null,
      which_line: "orderItem",
      line_qty: "5",
      in_generated_filing: false,
      id: "row2",
      entryType: "SALE",
      qty: "5",
      unitBasisQty: "60",
      netSales: "100.00",
      categoryTax: "8.00",
      soldAt: "2026-01-01",
      periodBucket: "2026-01",
      correctsEntryId: null,
      returnId: null,
      creditNoteId: null,
      createdAt: "2026-01-01",
    },
  ]);
  assert.equal(lines.get("cat1|li2").productPackNow, null);
});

t("groupByLineKey: product_found=true with a pack -> productPackNow is the Number", () => {
  const lines = groupByLineKey([
    {
      line_key: "li3",
      tenantId: "t1",
      trackedCategoryId: "cat1",
      orderItemId: "oi3",
      product_id: "p1",
      product_found: true,
      product_pack_now: "24",
      line_boxes: null,
      line_pieces: null,
      line_unit_label: null,
      line_units_per_box: 12,
      which_line: "orderItem",
      line_qty: "5",
      in_generated_filing: false,
      id: "row3",
      entryType: "SALE",
      qty: "5",
      unitBasisQty: "60",
      netSales: "100.00",
      categoryTax: "8.00",
      soldAt: "2026-01-01",
      periodBucket: "2026-01",
      correctsEntryId: null,
      returnId: null,
      creditNoteId: null,
      createdAt: "2026-01-01",
    },
  ]);
  assert.equal(lines.get("cat1|li3").productPackNow, 24);
});

// --- pickSourceLine: 0 or >1 live InvoiceItem candidates -> no source, never guessed -----------

t("pickSourceLine: no orderItemId -> no source, count 0", () => {
  const r = pickSourceLine(new Map(), undefined);
  assert.equal(r.source, null);
  assert.equal(r.count, 0);
});

t("pickSourceLine: exactly one candidate -> that candidate is the source", () => {
  const candidates = new Map([
    ["oi1", [{ id: "ii1", qty: 5, boxes: null, pieces: null, unitsPerBox: 12 }]],
  ]);
  const r = pickSourceLine(candidates, "oi1");
  assert.equal(r.count, 1);
  assert.equal(r.source.unitsPerBox, 12);
  assert.equal(r.chosen.id, "ii1");
});

t("pickSourceLine: zero or more than one candidate -> refused, never guessed", () => {
  const zero = pickSourceLine(new Map([["oi1", []]]), "oi1");
  assert.equal(zero.source, null);
  assert.equal(zero.count, 0);
  const many = pickSourceLine(
    new Map([
      [
        "oi2",
        [
          { id: "ii1", qty: 5 },
          { id: "ii2", qty: 5 },
        ],
      ],
    ]),
    "oi2",
  );
  assert.equal(many.source, null);
  assert.equal(many.count, 2);
});

// --- pickReturnItem / buildReturnEvidence: ambiguous match is refused, not guessed --------------

t("pickReturnItem: exactly one match -> returned; 0 or 2+ -> null (ambiguous refused)", () => {
  const byPair = new Map([
    ["ret1::p1", [{ kind: "STANDARD", qty: 3, pieces: null }]],
    ["ret2::p1", [{ qty: 1 }, { qty: 2 }]],
  ]);
  assert.equal(pickReturnItem(byPair, "ret1", "p1").qty, 3);
  assert.equal(pickReturnItem(byPair, "ret2", "p1"), null);
  assert.equal(pickReturnItem(byPair, "ret-missing", "p1"), null);
});

t("buildReturnEvidence: inline kind uses ReturnItem.pieces, standard uses qty", () => {
  const byPair = new Map([
    ["ret1::p1", [{ kind: "INLINE", qty: 3, pieces: 36 }]],
    ["ret2::p1", [{ kind: "STANDARD", qty: 3, pieces: null }]],
  ]);
  const attribution = new Map([
    ["ret1::p1", 1],
    ["ret2::p1", 1],
  ]);
  const inline = buildReturnEvidence({ returnId: "ret1" }, byPair, attribution, "p1");
  assert.equal(inline.kind, "inline");
  assert.equal(inline.qtyOrPieces, 36);
  const standard = buildReturnEvidence({ returnId: "ret2" }, byPair, attribution, "p1");
  assert.equal(standard.kind, "standard");
  assert.equal(standard.qtyOrPieces, 3);
});

t("buildReturnEvidence: a non-return-driven row (no returnId) -> undefined", () => {
  assert.equal(buildReturnEvidence({ returnId: null }, new Map(), new Map(), "p1"), undefined);
});

t("buildReturnEvidence: attribution split across >1 reversal -> attributionUnique false", () => {
  const byPair = new Map([["ret1::p1", [{ kind: "STANDARD", qty: 3, pieces: null }]]]);
  const attribution = new Map([["ret1::p1", 2]]); // this (returnId, productId) hits 2 reversals
  const ev = buildReturnEvidence({ returnId: "ret1" }, byPair, attribution, "p1");
  assert.equal(ev.attributionUnique, false);
});

// --- rowEvidence: glues buildLineContexts' output into computeLineCorrection's inputs ---------

t("rowEvidence: assembles sourceLine + returnEvidence from an entry+row+contexts", () => {
  const contexts = {
    candidatesByOrderItem: new Map([
      ["oi1", [{ id: "ii1", qty: 5, boxes: null, pieces: null, unitsPerBox: 12 }]],
    ]),
    returnItemsByPair: new Map(),
    attributionByPair: new Map(),
    rowsWithExistingCorrection: new Set(),
  };
  const entry = {
    orderItemId: "oi1",
    productId: "p1",
    productPackNow: 24,
    line: {
      boxes: null,
      pieces: null,
      unitLabel: null,
      unitsPerBox: 12,
      which: "orderItem",
      qty: "5",
    },
  };
  const row = { id: "row1", entryType: "SALE", returnId: null, creditNoteId: null };
  const { sourceLine, returnEvidence } = rowEvidence(entry, row, contexts);
  assert.equal(sourceLine.unitsPerBox, 12);
  assert.equal(returnEvidence, undefined);
});

t("BOX_UNAWARE_ROWS_SQL: scoped to one tenant, and createdAt is read as UTC", () => {
  assert.ok(BOX_UNAWARE_ROWS_SQL.includes('WHERE l."tenantId" = $1'));
  assert.ok(BOX_UNAWARE_ROWS_SQL.includes(`(l."createdAt" AT TIME ZONE 'UTC') AS "createdAt"`));
});

console.log(`b681-ledger-query self-test: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
