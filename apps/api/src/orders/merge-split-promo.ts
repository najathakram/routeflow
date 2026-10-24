import { PriceType } from "@prisma/client";
import type { PromotionRule } from "@routeflow/pricing";
import { reallocateFreeUnits, type FreeUnitLine } from "./product-free-units";
import type { MergeLine, MergeLineWrite } from "./merge-line-writes";

/**
 * B297 row 355 (SA-734r2 r-note 5): a buyer-driven merge of lines that row 340 keeps apart (different rate
 * trios) leaves ONE product on several lines of the surviving order. BUY_N_GET_M is a property of the
 * product's combined quantity, so the free units the merge earns are measured on that COMBINED whole-unit
 * count (what one line of the same size would earn) and allocated oldest line first, capped at each line's
 * units; `promoFreeUnits` stays per line (the rule lives in `product-free-units.ts`). A product that ends on
 * one line is untouched (the per-group fold already earned it). `canEarnNew` is the buyer-driven merge's
 * licence to earn units no line had; force-consolidate only re-measures and re-allocates what was earned.
 */
export interface SplitPromoOptions {
  promos: PromotionRule[];
  canEarnNew: boolean;
  categoryFor: (productId: string) => string | null;
  /** The live pack, for a box-split legacy line that never snapshotted its own. */
  liveUnitsPerBoxFor?: (productId: string) => number;
}

interface MergeFinal extends FreeUnitLine {
  write: Extract<MergeLineWrite, { kind: "create" }> | null;
}

export function allocateSplitFreeUnits(
  writes: MergeLineWrite[],
  winnerLines: readonly MergeLine[],
  opts: SplitPromoOptions,
): MergeLineWrite[] {
  if (opts.promos.length === 0) return writes;
  const updateFor = new Map<string, Extract<MergeLineWrite, { kind: "update" }>>();
  for (const w of writes) if (w.kind === "update") updateFor.set(w.lineId, w);

  // Only products this merge TOUCHED are settled: a winner-only product is never re-priced by a merge of
  // something else. A touched product is one a write creates a line of or updates a line of.
  const winnerProduct = new Map(winnerLines.filter((l) => l.id).map((l) => [l.id!, l.productId]));
  const touched = new Set<string>();
  for (const w of writes) {
    const pid = w.kind === "create" ? w.data.productId : winnerProduct.get(w.lineId);
    if (pid) touched.add(pid);
  }
  if (touched.size === 0) return writes;

  // Oldest first: the winner's existing lines by (createdAt, position, id) — the order a later settle reads
  // them in — then the lines this merge creates, in write order.
  const finals: MergeFinal[] = [];
  const stamp = (l: MergeLine) => {
    const r = l as unknown as { createdAt?: Date | string; position?: number | null };
    return [r.createdAt ? new Date(r.createdAt).getTime() : 0, r.position ?? 0] as const;
  };
  const winnersById = [...winnerLines]
    .filter((l) => l.productId && l.id && touched.has(l.productId))
    .sort((a, b) => {
      const [ta, pa] = stamp(a);
      const [tb, pb] = stamp(b);
      return ta - tb || pa - pb || (a.id! < b.id! ? -1 : 1);
    });
  for (const li of winnersById) {
    const u = updateFor.get(li.id!)?.data;
    finals.push({
      key: li.id!,
      write: null,
      productId: li.productId!,
      qty: Number(u?.qty ?? li.qty),
      boxes: u ? u.boxes : li.boxes,
      pieces: u ? u.pieces : li.pieces,
      pack: Number((u ? u.unitsPerBox : li.unitsPerBox) ?? 0),
      unitPrice: Number(li.unitPrice),
      free: Number(u && "promoFreeUnits" in u ? (u.promoFreeUnits ?? 0) : (li.promoFreeUnits ?? 0)),
      priceType: li.priceType,
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
      overriddenBy: li.overriddenBy,
      unitLabel: (li as unknown as { unitLabel?: string | null }).unitLabel ?? null,
    });
  }
  writes.forEach((w, i) => {
    if (w.kind !== "create") return;
    finals.push({
      key: `create:${i}`,
      write: w,
      productId: w.data.productId,
      qty: w.data.qty,
      boxes: w.data.boxes,
      pieces: w.data.pieces,
      pack: Number(w.data.unitsPerBox ?? 0),
      unitPrice: w.data.unitPrice,
      free: Number(w.data.promoFreeUnits ?? 0),
      priceType: w.data.priceType,
      originalPrice: w.data.originalPrice,
      overriddenBy: w.data.overriddenBy,
    });
  });

  const changes = new Map(reallocateFreeUnits(finals, opts).map((c) => [c.key, c]));
  if (changes.size === 0) return writes;
  const byKey = new Map(finals.map((f) => [f.key, f]));
  const out = writes.map((w, i) => {
    if (w.kind === "create") {
      const c = changes.get(`create:${i}`);
      if (!c) return w;
      changes.delete(`create:${i}`);
      return {
        ...w,
        data: { ...w.data, promoFreeUnits: c.free > 0 ? c.free : null, subtotal: c.subtotal },
      } as MergeLineWrite;
    }
    const c = changes.get(w.lineId);
    if (!c) return w;
    changes.delete(w.lineId);
    return {
      ...w,
      data: { ...w.data, promoFreeUnits: c.free > 0 ? c.free : null, subtotal: c.subtotal },
    } as MergeLineWrite;
  });
  // An untouched winner line the merge never wrote: its free units still moved, so it needs its own update.
  for (const [key, c] of changes) {
    const li = winnersById.find((l) => l.id === key);
    if (!li) continue;
    const f = byKey.get(key)!;
    out.push({
      kind: "update",
      lineId: key,
      data: {
        qty: f.qty,
        boxes: f.boxes,
        pieces: f.pieces,
        unitsPerBox: li.unitsPerBox ?? null,
        subtotal: c.subtotal,
        promoFreeUnits: c.free > 0 ? c.free : null,
      },
    });
  }
  return out;
}
