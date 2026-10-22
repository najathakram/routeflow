/**
 * SA-841 (#1493 B753 + #1400 B207): the ONE rule for adding qty to an EXISTING stored order line.
 *
 * Every server path that adds to a stored line converts BOTH sides to pieces at the line's OWN resolved pack before
 * summing, through this helper. Three cores re-decided the denomination on their own (B47, B199, B207, B753, B776 are
 * one class); a new merge path now makes one call here, and `stored-line-merge.pin.spec.ts` fails on a new bypass.
 *
 * Pure: no money inside. Callers keep `computeLineSubtotal` at the line's AGREED unitPrice with the result's
 * boxes/pieces/pack (never qty x unitPrice on a boxed line), plus `rescaleBogoFreeUnits` on whole units.
 */
import { normalizeBoxesPieces, packFromOwnSplit } from "@routeflow/pricing";
import { resolveLinePack } from "./merge-pack-resolve";

export interface StoredLineShape {
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
}

export interface StoredLineAdd {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
}

export interface MergeIntoStoredLineArgs {
  line: StoredLineShape;
  add: StoredLineAdd;
  /** How a BARE add qty (no split sent) is read: selling units (x the live pack) or loose pieces (staff scan, REG-B199). */
  bare: "sellingUnits" | "pieces";
  /** `keep`: an in-place update (a box-unaware line stays box-unaware, SA-104). `split`: a replaceAll rebuild (B47 shape). */
  output: "keep" | "split";
  /** The product's live pack. Read ONLY when the line has no pack of its own. */
  livePack: number;
}

export type MergeIntoStoredLineResult =
  | {
      ok: true;
      qty: number;
      boxes: number | null;
      pieces: number | null;
      unitsPerBox: number | null;
      /** The pack the line was resolved at (its own, else live). */
      pack: number;
      /** What was added, in the line's own unit: boxes on a kept box-unaware line, else pieces (DeliveryMutation.qty). */
      addInLineUnit: number;
      /** True when the line had no pack of its own and the live pack was used: the caller warns and counts. */
      usedLivePack: boolean;
    }
  | {
      ok: false;
      reason: "PACK_MISMATCH" | "LOOSE_INTO_BOX_UNAWARE" | "BOXED_INTO_UNPACKAGED";
      linePack: number;
      addPack: number | null;
    };

const int = (v: unknown): number => Math.trunc(Number(v ?? 0)) || 0;

export function mergeIntoStoredLine(args: MergeIntoStoredLineArgs): MergeIntoStoredLineResult {
  const { line, add, bare, output } = args;
  const livePack = int(args.livePack);
  // 1. the line's own pack: its unitsPerBox snapshot, else its own split, else live (box-unaware lines only)
  const { pack, usedLivePack } = resolveLinePack(line, livePack);
  const lineIsSplit = line.boxes != null;

  // 2. the incoming add, in pieces
  const sentSplit = add.boxes != null || add.pieces != null;
  let addPieces: number;
  if (sentSplit) {
    const addBoxes = int(add.boxes);
    const addLoose = int(add.pieces);
    if (addBoxes >= 1) {
      if (!(pack > 1))
        return { ok: false, reason: "BOXED_INTO_UNPACKAGED", linePack: pack, addPack: null };
      const filed = packFromOwnSplit({ qty: Number(add.qty), boxes: addBoxes, pieces: addLoose });
      if (filed != null && filed !== pack) {
        return { ok: false, reason: "PACK_MISMATCH", linePack: pack, addPack: filed };
      }
    }
    // a sent split wins over its qty (the normalizeBoxesPieces contract)
    addPieces = pack > 1 ? addBoxes * pack + addLoose : addLoose;
  } else if (bare === "sellingUnits") {
    // SA-104a(3): a bare selling unit is a box at the LIVE pack; a box-aware line priced at another pack refuses
    if (pack > 1 && !usedLivePack && livePack !== pack) {
      return {
        ok: false,
        reason: "PACK_MISMATCH",
        linePack: pack,
        addPack: livePack > 1 ? livePack : null,
      };
    }
    addPieces = pack > 1 ? Number(add.qty) * pack : Number(add.qty); // B661-sweep: SA-841's one bare-unit conversion
  } else {
    addPieces = Number(add.qty);
  }

  // 3. no pack: a plain sum
  if (!(pack > 1)) {
    return {
      ok: true,
      qty: Number(line.qty) + addPieces,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      pack,
      addInLineUnit: addPieces,
      usedLivePack,
    };
  }

  // 4. a box-aware line: re-split the pieces total at its own pack
  if (lineIsSplit) {
    const s = normalizeBoxesPieces({ qty: Number(line.qty) + addPieces, unitsPerBox: pack });
    return { ok: true, ...s, unitsPerBox: pack, pack, addInLineUnit: addPieces, usedLivePack };
  }

  // 5. a box-unaware line (qty is a box count)
  if (output === "keep") {
    // SA-104: never promoted in place; it gains whole boxes only
    if (addPieces % pack !== 0) {
      return { ok: false, reason: "LOOSE_INTO_BOX_UNAWARE", linePack: pack, addPack: null };
    }
    const addBoxes = addPieces / pack;
    return {
      ok: true,
      qty: Number(line.qty) + addBoxes,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      pack,
      addInLineUnit: addBoxes,
      usedLivePack,
    };
  }
  // `split`: a replaceAll rebuild re-derives every line anyway (B47): boxes to pieces, then normalize at the pack
  // B661-sweep: SA-841's one box-unaware-line conversion (a replaceAll rebuild re-derives the line anyway)
  const s = normalizeBoxesPieces({ qty: Number(line.qty) * pack + addPieces, unitsPerBox: pack });
  return { ok: true, ...s, unitsPerBox: pack, pack, addInLineUnit: addPieces, usedLivePack };
}
