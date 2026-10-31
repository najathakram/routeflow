import type {
  PriceHistoryAveragePoint,
  PriceHistoryComparisonLine,
  PriceHistoryRow,
} from "@/lib/api/price-history";

/**
 * The price-history chart's model (SA-954, mm-ux spec 2026-10-25). Pure: no React, no math on prices. The web draws the
 * server's numbers: the converted line is `comparison[].converted`, never recomputed here. This module only decides
 * WHICH numbers (the plot unit and pack, the matching comparison entry), WHETHER each line can draw, and what to say
 * when it cannot.
 */
export type LineId = "own" | "like" | "conv";

/** "case" and "box" name the same selling unit; everything else compares case-insensitively (as PriceHistory's `sameUnit`). */
const normUnit = (u: string | null | undefined): string => {
  const v = (u ?? "").trim().toLowerCase();
  return v === "box" || v === "cases" || v === "boxes" ? "case" : v;
};
const sameUnit = (a: string | null | undefined, b: string | null | undefined) =>
  normUnit(a) === normUnit(b);

/** A comparison entry's pack: the server sends null for "by the piece" there (a plot unit is always a known pack). */
const packOf = (p: number | null | undefined): number => p ?? 1;

/**
 * A history row's pack, from the server's own `salePack` (SA-1004): 1 = by the piece, > 1 = a pack, null = unknown.
 * The unit label is never consulted. An older server sends no `salePack` (a deploy skew): read `unitsPerBox` as before,
 * null meaning one piece.
 */
const rowPack = (r: Pick<PriceHistoryRow, "unitsPerBox" | "salePack">): number | null =>
  r.salePack === undefined ? (r.unitsPerBox ?? 1) : r.salePack;

export type ComparisonState = "loading" | "error" | "ready";

export interface ChartPoint {
  t: number;
  price: number;
  type?: string | null;
}

export interface RefPoint {
  month: string;
  t: number;
  price: number;
}

export interface ChartNote {
  /** DOM id, referenced by the disabled chips' `aria-describedby`. */
  id: string;
  text: string;
  role: "status" | "alert";
  /** The failure note offers Retry. */
  retry?: boolean;
  /** Which chips this note explains. */
  lines: LineId[];
}

export interface ChartModel {
  unitPhrase: string;
  /** Pieces per unit of the plot; null when there is neither a row nor a matching comparison entry. */
  plotPack: number | null;
  own: ChartPoint[];
  like: RefPoint[];
  conv: RefPoint[];
  canDraw: Record<LineId, boolean>;
  /** Some tab rows are not in the plot pack: the chart leaves them out and says so. */
  ownFiltered: boolean;
  notes: ChartNote[];
  /** Why chips 2 and 3 cannot draw while loading or failed, when the compare panel's own message covers it. */
  coveredByPanel: boolean;
}

export const NOTE_IDS = {
  neverSold: "ph-note-never-sold",
  compareMessage: "ph-compare-message",
} as const;

export const NOTE_COPY = {
  neverSold: "Not sold to this customer before.",
  neverSoldNoAverages: "There aren't enough sales to other customers to show an average yet.",
  noAverages: "No averages yet. Each needs 3 other buyers in a month.",
  likeEmpty: (unit: string) =>
    `All customers: no average for ${unit} yet. It needs 3 other buyers in a month.`,
  convEmpty: "All units: no average yet. It needs 3 other buyers in a month.",
  unavailable: "Averages aren't available.",
  loading: "Loading averages…",
  failed: "Couldn't load the averages.",
  filtered: (unit: string) => `The chart shows ${unit} sales only. The table lists them all.`,
  packUnknown:
    "These sales have no pack size on record, so they aren't on the chart. The table lists them.",
  turnOn: "Turn on a line to see it.",
} as const;

/** "2026-09" -> mid-month (UTC), where a monthly point sits on the time axis. */
export function monthMid(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y!, (m ?? 1) - 1, 15);
}

/** "2026-08" -> "Aug 2026". */
export function monthLabel(month: string): string {
  return new Date(monthMid(month)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The plot unit as a phrase: the tab's label, plus " of {pack}" when the pack is above 1 and the label carries no digit
 * ("Box of 12", "Case of 48", "Piece"; a stored "Case of 24" stays "Case of 24").
 */
export function unitPhrase(label: string, pack: number | null): string {
  return pack != null && pack > 1 && !/\d/.test(label) ? `${label} of ${pack}` : label;
}

const refPoints = (pts: PriceHistoryAveragePoint[] | undefined): RefPoint[] =>
  (pts ?? []).map((p) => ({ month: p.month, t: monthMid(p.month), price: p.average }));

export function buildChartModel(input: {
  unit: string | null;
  /** The tab's rows, in any order. */
  rows: readonly PriceHistoryRow[];
  /** `undefined` = an older server that sends no comparison. */
  comparison: readonly PriceHistoryComparisonLine[] | undefined;
  comparisonState: ComparisonState;
  /** The "All customers" panel is open: it shows its own loading and failure message for the same query. */
  panelOpen: boolean;
}): ChartModel {
  const { unit, rows, comparison, comparisonState, panelOpen } = input;
  const neverSold = rows.length === 0;
  // The plot (SA-1004): the newest KNOWN-pack row's pack, with the unit's entry at that pack. A tab with no known-pack row
  // (never sold, or only unknown-pack lines) takes the one entry the server sends for the unit, at any pack (D2).
  const known = rows.filter((r) => rowPack(r) !== null);
  const newestKnown = [...known].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  )[0];
  const knownPack = newestKnown ? rowPack(newestKnown) : null;
  const entry =
    unit == null || !comparison
      ? undefined
      : comparison.find(
          (e) =>
            sameUnit(e.unitLabel, unit) &&
            (knownPack === null || packOf(e.unitsPerBox) === knownPack),
        );
  const plotPack = knownPack ?? (entry ? packOf(entry.unitsPerBox) : null);
  const phrase = unitPhrase(unit ?? entry?.unitLabel ?? "", plotPack);

  const inPack = knownPack === null ? [] : known.filter((r) => rowPack(r) === knownPack);
  const own: ChartPoint[] = [...inPack]
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((r) => ({ t: new Date(r.date).getTime(), price: r.unitPrice, type: r.priceType }));
  const ownFiltered = rows.length > inPack.length;
  const onlyUnknownPack = !neverSold && known.length === 0;

  const ready = comparisonState === "ready";
  const like = ready ? refPoints(entry?.likeForLike) : [];
  const conv = ready ? refPoints(entry?.converted) : [];
  const canDraw: Record<LineId, boolean> = {
    own: own.length > 0,
    like: like.length > 0,
    conv: conv.length > 0,
  };

  const coveredByPanel = panelOpen && comparisonState !== "ready";
  const notes: ChartNote[] = [];
  if (onlyUnknownPack)
    notes.push({
      id: "ph-note-pack-unknown",
      text: NOTE_COPY.packUnknown,
      role: "status",
      lines: ["own"],
    });
  if (comparisonState === "loading" && !panelOpen) {
    notes.push({
      id: "ph-note-loading",
      text: NOTE_COPY.loading,
      role: "status",
      lines: ["like", "conv"],
    });
  } else if (comparisonState === "error" && !panelOpen) {
    notes.push({
      id: "ph-note-failed",
      text: NOTE_COPY.failed,
      role: "alert",
      retry: true,
      lines: ["like", "conv"],
    });
  } else if (ready) {
    if (comparison === undefined) {
      notes.push({
        id: "ph-note-unavailable",
        text: NOTE_COPY.unavailable,
        role: "status",
        lines: ["like", "conv"],
      });
    } else if (!canDraw.like && !canDraw.conv) {
      notes.push({
        id: "ph-note-none",
        text: neverSold ? NOTE_COPY.neverSoldNoAverages : NOTE_COPY.noAverages,
        role: "status",
        lines: ["like", "conv"],
      });
    } else {
      if (!canDraw.like)
        notes.push({
          id: "ph-note-like",
          text: NOTE_COPY.likeEmpty(phrase),
          role: "status",
          lines: ["like"],
        });
      if (!canDraw.conv)
        notes.push({
          id: "ph-note-conv",
          text: NOTE_COPY.convEmpty,
          role: "status",
          lines: ["conv"],
        });
    }
  }
  if (ownFiltered && canDraw.own)
    notes.push({
      id: "ph-note-filtered",
      text: NOTE_COPY.filtered(phrase),
      role: "status",
      lines: ["own"],
    });

  return {
    unitPhrase: phrase,
    plotPack,
    own,
    like,
    conv,
    canDraw,
    ownFiltered,
    notes,
    coveredByPanel,
  };
}
