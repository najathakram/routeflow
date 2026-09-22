import { resolvePackFactors, type PackLine } from "./line-pack-factors";
import { deriveLinePack } from "@routeflow/pricing";

/**
 * SA-076a Ruling 2 (Q2) -- `deriveLinePack` (`@routeflow/pricing`) mirrors `resolvePackFactors`'
 * pairing rule verbatim (SA-069b: this repo's ONE source of truth for it), scoped to a single
 * line instead of a batch. This spec proves the two answer identically over the same fixtures
 * (one / none / several live InvoiceItems, VOID already excluded, source-boxes vs source-pieces,
 * a line-level `unitsPerBox` snapshot gating ahead of the live product) so the two can never
 * silently drift apart. A follow-up moves the pairing fully into `@routeflow/pricing`, retiring
 * this file's own copy of the adapter below; until then this is the parity guarantee.
 */

/** Runs `resolvePackFactors` over a SINGLE line + its candidate InvoiceItems, returning that
 *  one line's own answer (undefined when the line doesn't need pack resolution at all --
 *  `resolvePackFactors` simply omits it, `deriveLinePack` is never called for such a line by
 *  `computeLineCorrection` either -- see this file's own `needsPackResolution`). */
async function viaResolvePackFactors(line: PackLine, candidates: unknown[]) {
  const out = await resolvePackFactors({
    orderId: "order1",
    lines: [line],
    loadInvoiceItems: async () => new Map([[line.id, candidates]]),
  });
  return out.get(line.id);
}

/** The SAME adapter `apps/api/src/common/line-pack-factors.ts`'s own `resolvePackFactors` uses
 *  internally to call `legacyLinePieces` (relation "full", productPackNow gated on the line's own
 *  `unitsPerBox` snapshot) -- reproduced here ONLY to drive `deriveLinePack` the identical way,
 *  never as a second copy of the pairing RULE itself (that rule lives in `deriveLinePack` alone). */
function viaDeriveLinePack(line: PackLine, candidates: any[]) {
  const source = candidates.length === 1 ? candidates[0] : null;
  const snapshotProvesBoxedAtSale = Number(line.unitsPerBox ?? 0) > 1;
  return deriveLinePack(
    {
      qty: Number(line.qty),
      boxes: line.boxes ?? null,
      pieces: line.pieces ?? null,
      unitsPerBox: line.unitsPerBox ?? null,
    },
    source
      ? {
          qty: Number(source.qty),
          boxes: source.boxes ?? null,
          pieces: source.pieces ?? null,
          unitsPerBox: source.unitsPerBox ?? null,
        }
      : null,
    line.product && !snapshotProvesBoxedAtSale ? (line.product.unitsPerBox ?? null) : undefined,
  );
}

describe("deriveLinePack / resolvePackFactors parity", () => {
  const cases: Array<{ name: string; line: PackLine; candidates: any[] }> = [
    {
      name: "one live InvoiceItem, source-boxes (a box-count copy: qty 5 === source boxes 5, !== source qty 60)",
      line: { id: "l1", productId: "p1", qty: 5, product: { unitsPerBox: 12 } },
      candidates: [{ qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12 }],
    },
    {
      // pieces: 0 (not null) is what makes the SOURCE carry a split at all -- sourceHasSplit
      // gates the source-pieces branch just as much as it gates source-boxes; a source with
      // NEITHER set falls through to "no split on the line, and the source has no split either".
      name: "one live InvoiceItem, source-pieces (qty already matches the source's own qty -- factor 1 by definition of that branch)",
      line: { id: "l2", productId: "p1", qty: 24, product: { unitsPerBox: 12 } },
      candidates: [{ qty: 24, boxes: null, pieces: 0, unitsPerBox: 12 }],
    },
    {
      name: "zero live InvoiceItems -- both unknown, never guessed",
      line: { id: "l3", productId: "p1", qty: 5, product: { unitsPerBox: 12 } },
      candidates: [],
    },
    {
      name: "the line's own unitsPerBox snapshot gates instead of a since-changed live product",
      line: { id: "l5", productId: "p1", qty: 5, unitsPerBox: 12, product: { unitsPerBox: 99 } },
      candidates: [{ qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12 }],
    },
    {
      name: "VOID invoice already excluded upstream -- zero candidates reach either function the same way",
      line: { id: "l6", productId: "p1", qty: 5, product: { unitsPerBox: 12 } },
      candidates: [], // returns-restock-pieces.ts's own loadInvoiceItems excludes VOID before this point
    },
  ];

  for (const { name, line, candidates } of cases) {
    it(`${name} -- identical answer`, async () => {
      const viaResolve = await viaResolvePackFactors(line, candidates);
      const viaDerive = viaDeriveLinePack(line, candidates);
      expect(viaDerive).toEqual(viaResolve);
    });
  }

  it("two live InvoiceItems -- ambiguous, both unknown (the order line was billed across several)", async () => {
    // The REASON text legitimately differs here, not the answer: resolvePackFactors sees the
    // candidate COUNT itself (2) and names it in its own refusal message before ever calling
    // legacyLinePieces; deriveLinePack only ever receives an already-resolved source-or-null (its
    // caller -- pickSourceLine in the B681 lib, same as resolvePackFactors' own count check --
    // collapses "0 candidates" and "2+ candidates" to the same `null`), so it cannot distinguish
    // WHY there's no source, only that there isn't one. Both refuse to guess -- that's the parity
    // this proves; the count-aware wording is `resolvePackFactors`'s own, not part of the shared
    // pairing rule.
    const line: PackLine = { id: "l4", productId: "p1", qty: 5, product: { unitsPerBox: 12 } };
    const candidates = [
      { qty: 60, boxes: 5, pieces: 0, unitsPerBox: 12 },
      { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 },
    ];
    const viaResolve = await viaResolvePackFactors(line, candidates);
    const viaDerive = viaDeriveLinePack(line, candidates);
    expect(viaResolve).toEqual({
      unknown: true,
      reason:
        "the order line was billed across 2 invoice items, so none of them is a 1:1 source for its pack",
    });
    expect(viaDerive).toEqual({ unknown: true, reason: expect.any(String) });
  });
});
