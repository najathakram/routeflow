/**
 * The pure half of the order-item editor (`app/(operator)/(tabs)/orders/[id]/edit-items.tsx`).
 *
 * Everything here is a derivation over the staged edit: what Save would send,
 * whether there is anything to send, the on-device snapshot that keeps the
 * operator's work across a leave, and the rows the picker's pull-out drawer
 * renders. It exists because the screen previously derived each of those
 * inline, where the mobile Jest lane (`jest.config.js` — `testEnvironment:
 * "node"`) can never reach them.
 *
 * PURITY IS A CONTRACT, not a preference: this module must NEVER import
 * `react-native` or `@react-native-async-storage/async-storage`. The screen
 * owns every `getItem`/`setItem`/`removeItem`; this module only shapes and
 * validates the payload. `__tests__/edit-items-drawer.test.ts` pins that.
 *
 * MONEY: no subtotal is derived here. `draftTrayRows` delegates to
 * `lib/scan-tray.ts#trayRowsFrom`, which is the one place a tray row's money
 * comes from (`@routeflow/pricing#computeLineSubtotal`), and it threads the
 * screen's BUY_N_GET_M netting through so the drawer, the line card and the
 * footer cannot disagree.
 */
import type { ProductUnitLevel } from "@routeflow/types";
import { isFamilyProduct } from "./sellable-products";
import { needsUnitLabelConfirm } from "./scan-unit-confirm";
import {
  roundMoney,
  effectiveQty,
  unitLineCount,
  type LadderProduct,
  type SellLevel,
} from "@routeflow/pricing";
import {
  buildOrderItemDiff,
  type DiffCatalogLine,
  type DiffUnlistedLine,
  type OriginalLine,
} from "./order-item-diff";
import { editedLineFreeUnits } from "./invoice-totals";
import { lineUnitsPerBox } from "./at-door-line-units";
import { trayRowsFrom, type TrayRow } from "./scan-tray";
import { defaultStartOption, unitPriceBase, type UnitOption } from "./unit-options";
import { incrementLine, incrementLinePiece, isUnitLine } from "./sale-line";
import type { UpdateOrderItemInput } from "./api/orders";

/** Shared with the route file's own "Add unlisted item" flow. */
export function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One row of the in-progress edit. `qty` is total pieces (server's source of
 * truth). For products with `unitsPerBox > 1` operators may also set
 * `boxes`/`pieces` and the server recomputes qty + uses BOX-price proration
 * (see apps/api/src/orders/orders.service.ts:594).
 */
export type DraftItem = {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitsPerBox?: number | null;
  unitPrice: number;
  /** The customer's tier/base price — new lines send an override only if unitPrice diverges. */
  catalogPrice: number;
  name: string;
  unit?: string;
  overrideReason?: string;
  /** Per-line note (buyer-visible) — must round-trip through the save. */
  notes?: string;
  /** Original DB line id; undefined = added this session. */
  lineId?: string;
  /** The line was stored with a box split — send boxes/pieces on save only then. */
  boxSplit?: boolean;
  /**
   * units_v1: the unit this line is sold by ("Case"…), carried unchanged from
   * the stored line — this screen never sets or clears one. Required on the
   * UPDATE wire payload whenever set, or the server refuses the edit
   * (UNIT_AWARE_LINE) since a bare qty would be misread as pieces (B707).
   */
  unitLabel?: string | null;
  /**
   * units_v1: the currently-active unit's own resolved tier price — the comparison base
   * `unitPrice` diverging from means a genuine operator override, in place of `catalogPrice`
   * (the PACK's price) whenever `unitLabel` is set (a Case's price is never the Box's, even with
   * no override typed). Unset while `unitLabel` is unset.
   */
  unitBasePrice?: number;
  /**
   * units_v1 (SA-085f HIGH #2): the REAL product's ladder inputs — its own pack
   * unit/unitsPerBox and all 5 tier-price columns — snapshotted once from the embedded
   * `product` record (hydration) or the picker's product (a fresh add). Never reconstructed
   * from this row's own mutable fields: a stored unit line's `unitsPerBox` is the CHOSEN
   * UNIT's own factor (the server's snapshot convention, unit-line-build.ts), not the pack's,
   * and this row's `catalogPrice`/`unitPrice` are the line's price, not the product's tier
   * ladder. `UnitPickerRow` prices off THIS, exactly like `resolveUnitPrice` does server-side.
   */
  packLadder?: LadderProduct;
  /** Set when this row substitutes a different product onto its original line. */
  substituteProductId?: string;
  /**
   * Per-piece average cost + category — drives the live margin hint
   * (pos-cost-roles-spec §1). Only `averageCost` is available here (the
   * order's embedded product `select` doesn't include `standardCost`, unlike
   * the separate `/products` list `NewOrderScreen` reads from) — rows with no
   * average cost yet (never sold) simply show no hint.
   */
  averageCost?: number | string | null;
  category?: string | null;
  /** UI-only qty entry mode for a case-packed line. NEVER submitted — the
   *  diff always carries {qty, boxes, pieces} and the per-case unitPrice. */
  sellBy?: "case" | "unit";
  /**
   * BUY_N_GET_M snapshot on the loaded line + the whole selling-unit count it
   * was earned at. The preview MUST net these off or a BOGO line shows at full
   * price and disagrees with both the stored subtotal and what the server
   * re-derives on save (mirrors web's order edit builder).
   */
  promoFreeUnits?: number | null;
  promoBaseUnits?: number | null;
  /**
   * #2231 / SA-388: a stored unit line whose COUNT can't be derived (see `unitLineCount`).
   * Its qty is not editable and any edit to it refuses to save (`repairBlockedLines`) —
   * the server needs a count on every unit-line UPDATE, and guessing one bills wrong.
   */
  needsRepair?: boolean;
  /**
   * UI-only: the qty a line added THIS session was created with. The default selling unit applies once, only while `qty`
   * still equals it and no unit is held (any quantity edit or unit pick ends the default-start). Never submitted.
   */
  startOnDefaultUnit?: number;
};

/**
 * A new ad-hoc (unlisted) line being added in this edit session. Serialised as
 * `{ name, qty, unitPrice }` on save (no productId; never boxed). Existing
 * unlisted lines on the order are NOT loaded here (the replace-all edit only
 * re-sends catalog lines + any newly added unlisted lines).
 */
export type UnlistedDraft = {
  id: string;
  name: string;
  unitPrice: number;
  qty: number;
  /** Per-line note (buyer-visible) — must round-trip through the save. */
  notes?: string;
  /** Original DB line id for an existing unlisted line; undefined = new. */
  lineId?: string;
};

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Server lines -> the editor's staged shape. Lives here, not the route file,
 * so red-first tests can reach it directly — jest cannot import a route file
 * (expo-router hooks fire on import), same reason B657/#1171 pulled
 * `lineUnitsPerBox` out of `adjust.tsx` into `at-door-line-units.ts`.
 *
 * B707: `unitsPerBox` comes from the line's OWN stored snapshot first via
 * `lineUnitsPerBox` — the live product is only a fallback for a legacy line
 * with none, never the other way. Reading the live product ALONE (the
 * pre-fix bug) desyncs an already-agreed line the moment its product is
 * repacked: a unit line's fabricated qty change gets refused server-side
 * (UNIT_AWARE_LINE, since the request then carries no `unitLabel`), and a
 * legacy box-split line is silently re-denominated at the new pack size.
 * `unitLabel` is carried through unchanged too — this screen never sets or
 * clears a line's unit, only resends the one it was loaded with (see
 * `stagedDiffItems` below, which puts it on the wire for a unit line's save).
 */
// #2231 / SA-388 rule 1: the COUNT of a stored unit line — ONE implementation in
// @routeflow/pricing (#2276; web and mobile had drifting copies). Re-exported so buyer-edit-items
// and the specs keep importing it from here.
export { unitLineCount };

export function hydrateFromOrder(order: { lineItems?: readonly any[] | null } | null | undefined): {
  draft: Record<string, DraftItem>;
  unlisted: UnlistedDraft[];
} {
  const next: Record<string, DraftItem> = {};
  const nextUnlisted: UnlistedDraft[] = [];
  for (const li of order?.lineItems ?? []) {
    // Unlisted line (no productId): carry it through the replace-all save so
    // it isn't lost. `name` holds the free-text label.
    // Skip already-cancelled lines (they aren't editable and shouldn't diff).
    if ((li as any).status === "CANCELLED") continue;
    if (!li.productId) {
      nextUnlisted.push({
        id: li.id ?? newLocalId(),
        lineId: li.id ?? undefined,
        name: li.name ?? "Unlisted item",
        unitPrice: toNumber(li.unitPrice),
        qty: toNumber(li.qty),
        notes: (li as any).notes ?? undefined,
      });
      continue;
    }
    const product = (li as any).product ?? {};
    const catalogPrice = toNumber(product.pricePerUnit ?? li.unitPrice);
    const unitsPerBox = lineUnitsPerBox({ unitsPerBox: li.unitsPerBox, product });
    const unitLabel = li.unitLabel ?? undefined;
    // SA-085f MEDIUM #4: a stored unit line persists qty/boxes/pieces on the server's PACK-PIECE
    // basis (buildUnitLine, unit-line-build.ts — a 2-Case line is qty:480, boxes:2), so its
    // ONE qty basis is the COUNT, matching every unit line this session picks fresh via
    // setUnitLabel (qty:<count>, boxes/pieces unset). Normalize once, here, so the count is
    // `item.qty` everywhere downstream — the steppers, the margin hint, the on-screen "Qty
    // (Case) N" — and `buildOrderItemDiff`'s existing `line.boxes ?? line.qty` wire fallback
    // still resolves correctly (boxes is now always unset for a unit line).
    // #2231 / SA-388: the count comes from ONE rule (unitLineCount); an underivable one is 0
    // + needsRepair (0 on both this side and orderOriginals', so untouched it sends nothing).
    const count = unitLabel ? unitLineCount(li) : null;
    const qty = unitLabel ? (count ?? 0) : toNumber(li.qty);
    // B775 (SA-101/SA-108): key by the line's OWN id — the record key is the
    // ONLY identity, never a `?? productId` fallback. units_v1 can legitimately
    // carry two lines for the same product (a Case line + a pack line), and a
    // non-unit order can too (create() maps dto.items one OrderItem per entry
    // with no dedupe, no @@unique([orderId, productId])). Keying by productId
    // collapsed the second line into the first at hydration; order-item-diff.ts
    // then read the dropped line's id as missing from the surviving set and
    // emitted {id, action:"DELETE"} for it — even on a zero-edit Save, since
    // the collision happens here, before any operator interaction. `li.id` is
    // always present for an existing (server-loaded) line.
    next[li.id] = {
      productId: li.productId,
      qty,
      boxes: unitLabel ? undefined : (li.boxes ?? undefined),
      pieces: unitLabel ? undefined : (li.pieces ?? undefined),
      unitsPerBox,
      unitLabel,
      unitPrice: toNumber(li.unitPrice),
      catalogPrice,
      // The product's OWN pack factor — never the line's `unitsPerBox` above, which on a
      // stored unit line is the chosen unit's factor, not the pack's (see the field doc).
      packLadder: buildPackLadder({
        ...product,
        pricePerUnit: product.pricePerUnit ?? li.unitPrice ?? 0,
      }),
      name: product.name ?? "Item",
      unit: product.unit,
      overrideReason: li.overrideReason ?? undefined,
      notes: (li as any).notes ?? undefined,
      lineId: li.id ?? undefined,
      // Preserve the stored denomination so a qty-only edit doesn't invent a split. A unit
      // line is never box-split (its boxes/pieces are normalized away above, matching
      // setUnitLabel's own convention for a freshly-picked one).
      boxSplit: !unitLabel && (li.boxes != null || li.pieces != null),
      // NEW (P10-POS-1): read via the existing `any`-cast `product` ref above —
      // the server already returns these on the order's embedded product, only
      // AdminOrder's TS type doesn't declare them yet (out of scope here).
      averageCost: product.averageCost ?? null,
      category: product.category ?? null,
      // BUY_N_GET_M: the snapshot plus the selling-unit count it was earned
      // at, so a qty edit rescales it exactly like the server does on save.
      promoFreeUnits: li.promoFreeUnits ?? null,
      promoBaseUnits: li.promoFreeUnits
        ? unitLabel
          ? count
          : Math.trunc(Number(li.boxes != null ? li.boxes : li.qty) || 0)
        : null,
      ...(unitLabel && count == null ? { needsRepair: true } : {}),
    };
  }
  return { draft: next, unlisted: nextUnlisted };
}

/**
 * Apply a `UnitPickerRow` choice to a draft line (SA-085f, size-ratchet extraction out of
 * edit-items.tsx's `setUnitLabel` — the route file's own tsc-guarded line cap). `qty` resets to
 * the count (1), boxes/pieces clear (a unit line is a plain qty x unitPrice line). `unitPrice`
 * AND `unitBasePrice` both take the option's own resolved price — same value in both, so
 * `isOverridden` reads false immediately after picking (a lookup, not an operator override)
 * until the operator's own price edit diverges the two.
 *
 * `unitsPerBox` means "the current selling unit's own factor" (SA-085f HIGH #3): the pack's own
 * factor while unset (restored from `packLadder`, the untouched real snapshot — never `cur`'s own
 * mutable field, which IS that factor while a unit is active), else the picked unit's factor —
 * so the margin/floor hint always multiplies cost by the right pieces-per-unit.
 *
 * `packTierPrice` is the caller's already-resolved live tier price for the pack (SA-085f LOW:
 * `cur.catalogPrice` is the product's LIST price on a hydrated/stored line, never tier-adjusted —
 * restoring it on a pack-switch would show the wrong price to a tier≠1 customer).
 */
/**
 * The REAL product's ladder inputs for a draft row's `UnitPickerRow` (SA-085f HIGH #2,
 * size-ratchet extraction) — the snapshotted `packLadder` when one exists, else a best-effort
 * fallback (a legacy on-device snapshot from before this field existed) that at least carries
 * the pack's own price, never the corrupted `unitsPerBox`/`catalogPrice` a mini-product built
 * from the row's OWN mutable fields used to.
 */
export function ladderProductFor(
  item: Pick<DraftItem, "unit" | "unitsPerBox" | "catalogPrice" | "packLadder">,
): LadderProduct {
  return (
    item.packLadder ?? {
      unit: item.unit ?? null,
      unitsPerBox: item.unitsPerBox ?? null,
      pricePerUnit: item.catalogPrice,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
    }
  );
}

/** A fresh add's ladder snapshot (SA-085f HIGH #2, size-ratchet extraction) — see `packLadder`. */
export function buildPackLadder(p: {
  unit?: string;
  unitsPerBox?: number | null;
  pricePerUnit: number | string;
  priceTier2?: number | string | null;
  priceTier3?: number | string | null;
  priceTier4?: number | string | null;
  priceTier5?: number | string | null;
}): LadderProduct {
  return {
    unit: p.unit ?? null,
    unitsPerBox: p.unitsPerBox ?? null,
    pricePerUnit: p.pricePerUnit,
    priceTier2: p.priceTier2 ?? null,
    priceTier3: p.priceTier3 ?? null,
    priceTier4: p.priceTier4 ?? null,
    priceTier5: p.priceTier5 ?? null,
  };
}

export function applyUnitPick(
  cur: DraftItem,
  option: UnitOption,
  packTierPrice: number,
): DraftItem {
  const isPack = option.value === "";
  return {
    ...cur,
    startOnDefaultUnit: undefined,
    unitLabel: isPack ? undefined : option.value,
    unitBasePrice: isPack ? undefined : option.price,
    unitsPerBox: isPack ? (cur.packLadder?.unitsPerBox ?? cur.unitsPerBox) : option.factorToBase,
    qty: 1,
    boxes: undefined,
    pieces: undefined,
    boxSplit: false,
    unitPrice: isPack ? packTierPrice : option.price,
  };
}

/** A line added this session that still waits for its default selling unit: untouched quantity, no unit held. */
export function startsOnDefaultUnit(
  item: Pick<DraftItem, "startOnDefaultUnit" | "qty" | "unitLabel">,
): boolean {
  return item.startOnDefaultUnit != null && item.qty === item.startOnDefaultUnit && !item.unitLabel;
}

/**
 * A new line moved onto the product's default selling unit (the level flagged `isDefaultSelling`, only if the picker
 * offers it), exactly like web's Create Order (`defaultStartOption`). With nothing flagged/offered the line is returned
 * as it was. This is the same decision `UnitPickerRow` makes when it mounts with `startOnDefaultUnit`.
 */
export function startNewLineOnDefault(
  item: DraftItem,
  units: readonly ProductUnitLevel[],
  tier: number,
  packTierPrice: number,
): DraftItem {
  if (!startsOnDefaultUnit(item)) return item;
  const start = defaultStartOption(ladderProductFor(item), units, tier, {
    hasUnit: !!item.unitLabel,
  });
  return start ? applyUnitPick(item, start, packTierPrice) : item;
}

/**
 * SA-085i(c): a non-unit line's Cases/Loose edit matches master's OLD inline rule byte-for-
 * byte — the typed count REPLACES qty; a legacy line's plain (un-split) qty is never
 * reinterpreted as loose pieces. The shared sale-line.ts fold (`splitFromPrev`, correct for
 * NewOrderScreen's own in-session cart accumulation) reads a no-split qty as PIECES, which
 * would invent phantom loose units out of a STORED historical qty the first time this screen's
 * own Cases/Loose steppers touch it — a separate, pre-existing bug, not fixed here. A
 * unit-sold line refuses the edit outright (returns unchanged; the UI never shows this
 * control for one, but this is the executable half of that guarantee).
 */
export function applyBoxEdit(cur: DraftItem, boxes: number, unitsPerBox: number): DraftItem {
  if (cur.unitLabel) return cur;
  const b = Math.max(0, Math.floor(boxes));
  const pieces = cur.pieces ?? 0;
  return {
    ...cur,
    boxes: b,
    pieces,
    qty: b * unitsPerBox + pieces,
    boxSplit: true,
    startOnDefaultUnit: undefined,
  };
}

/** SA-085i(c): the loose-pieces counterpart of `applyBoxEdit` — see its doc comment. */
export function applyPieceEdit(cur: DraftItem, pieces: number, unitsPerBox: number): DraftItem {
  if (cur.unitLabel) return cur;
  const pcs = Math.max(0, Math.floor(pieces));
  const boxes = cur.boxes ?? 0;
  return {
    ...cur,
    boxes,
    pieces: pcs,
    qty: boxes * unitsPerBox + pcs,
    boxSplit: true,
    startOnDefaultUnit: undefined,
  };
}

/**
 * B775 (fleet lead review, rules 1+2): the draft key a scan/add should
 * write to. Merges into an EXISTING entry for the SAME product AND the
 * SAME unit (`unitLabel` — `undefined`/`null` both mean "base/boxed", the
 * only shape a scan can ever represent; a scan must never merge into a
 * units_v1 selling-unit line like a Case). Matched by VALUE, since the
 * draft record is keyed by lineId/a fresh local id, never bare productId.
 * `Object.entries` iteration order is the draft's own (display) order, so
 * with more than one legacy match (two non-unit lines already on one
 * product — reachable only pre-fix, or from data written outside this
 * screen) this deliberately merges into the FIRST and never touches the
 * others. No match at all — including every genuinely new addition — gets
 * a FRESH key, never the bare productId: two new same-product rows added
 * in different units (or two independent adds before either is saved)
 * must never collide the same way hydration did.
 *
 * CAUTION (currently unreachable, but load-bearing the day it isn't): a
 * `new:<id>` row's key is never re-keyed to the server's real id in place —
 * this screen only ever re-reads it via `hydrateFromOrder` after a save,
 * which always follows `leaveEditor()` and remounts the screen fresh. That
 * is safe only as long as every successful save leaves the editor. The day a
 * "save and stay" flow exists, a saved `new:<id>` row would keep its local
 * key while the record it maps to now has a real lineId — any code added
 * for that flow must explicitly re-key the draft entry (swap the `new:<id>`
 * key for the returned lineId), not assume this function's callers already
 * handle it.
 */
export function resolveDraftKeyForPick(
  draft: Record<string, DraftItem>,
  productId: string,
  unitLabel?: string | null,
): string {
  if (!unitLabel) {
    const match = Object.entries(draft).find(
      ([, it]) => it.productId === productId && !it.unitLabel,
    );
    if (match) return match[0];
  }
  return newDraftKey();
}

/**
 * B775 (SA-103): the key for a NOT-YET-SAVED row — always `new:` prefixed,
 * never a bare productId (two unsaved same-product rows, e.g. one added
 * per unit, would collide again exactly like the hydration bug this fixes)
 * and never a bare counter alone (recognizably distinct from a real DB
 * line id, e.g. for the save response's re-key step). Reuses `newLocalId`'s
 * existing per-session-unique generator rather than introducing separate
 * counter state.
 */
export function newDraftKey(): string {
  return `new:${newLocalId()}`;
}

/** The inputs `applyPickToDraft` needs beyond the draft key it writes to. */
export interface PickInput {
  productId: string;
  unitsPerBox: number | null;
  /** The price to start a FRESH row at — already resolved (price-history vs.
   *  tier/list) by the caller; this function never re-derives it. */
  startPrice: number;
  catalogPrice: number;
  name: string;
  unit?: string;
  level: SellLevel;
  /** A FAMILY container is never added: the pick is a no-op. */
  kind?: "FAMILY" | "STANDARD" | "VARIANT" | "RECIPE" | null;
  /** The fresh-add ladder snapshot (`ladderProductFor`'s real-tier-prices
   *  input) — only used on a fresh add; an existing entry keeps its own. */
  packLadder?: LadderProduct;
}

/**
 * SA-108d (E44 correction of SA-108a): the merge/add transform a scan or tap
 * applies to the draft, extracted to a PURE function of `(draft, key, input)`
 * alone — no closure over component state, no side effects. This is what
 * makes it safe to run TWICE for one logical pick: once synchronously by the
 * caller (`draftRef.current = applyPickToDraft(draftRef.current, key,
 * input)`) to keep the ref an accurate same-tick mirror, and once more
 * whenever React actually processes the `setDraft` update it was ALSO handed
 * to — a functional setState updater must never itself write to a ref (see
 * `resolveDraftKeyForPick`'s caller in edit-items.tsx): React does not
 * reliably run it synchronously even for the first call in a same-tick
 * burst, since the eager-dispatch path also requires the alternate fiber's
 * lanes to be empty, which a component's own earlier renders can leave
 * non-empty. `key` is resolved by the CALLER (via `resolveDraftKeyForPick`)
 * before this runs — never re-derived here, and never re-derived from an
 * existing entry's own fields (the SA-108 bug this whole lineage fixes).
 */
export function applyPickToDraft(
  draft: Record<string, DraftItem>,
  key: string,
  input: PickInput,
): Record<string, DraftItem> {
  if (isFamilyProduct(input)) return draft; // a family container is never a line
  const existing = draft[key];
  const upb = Number(existing?.unitsPerBox ?? input.unitsPerBox ?? 0);
  const boxed = upb > 1;
  if (existing) {
    // units_v1 (SA-085f): a re-scan of an already unit-sold line merges into
    // its COUNT — never the pack's box math, regardless of scan kind.
    if (boxed && !isUnitLine(existing)) {
      const line =
        input.level === "UNIT"
          ? incrementLinePiece(existing, true, upb)
          : incrementLine(existing, true, upb);
      return { ...draft, [key]: { ...line, boxSplit: true } };
    }
    return { ...draft, [key]: { ...existing, qty: (existing.qty ?? 0) + 1 } };
  }
  const base = {
    productId: input.productId,
    unitsPerBox: input.unitsPerBox,
    unitPrice: input.startPrice,
    catalogPrice: input.catalogPrice,
    name: input.name,
    unit: input.unit,
    packLadder: input.packLadder,
  };
  if (boxed) {
    // 1 box for a case scan/tap; 1 LOOSE piece for a piece-code scan.
    // Only a tap/case add starts on the default unit; a piece-code scan's level is decided by the code (as web).
    return input.level === "UNIT"
      ? { ...draft, [key]: { ...base, qty: 1, boxes: 0, pieces: 1, boxSplit: true } }
      : {
          ...draft,
          [key]: {
            ...base,
            qty: upb,
            boxes: 1,
            pieces: 0,
            boxSplit: true,
            startOnDefaultUnit: upb,
          },
        };
  }
  return {
    ...draft,
    [key]: { ...base, qty: 1, ...(input.level === "UNIT" ? {} : { startOnDefaultUnit: 1 }) },
  };
}

/** The screen's own resolved inputs a pick needs, beyond what `PickInput` already covers. */
export interface ResolvePickTargetInput {
  productId: string;
  name: string;
  unit?: string;
  unitsPerBox: number | null;
  level: SellLevel;
  kind?: PickInput["kind"];
  startPrice: number;
  catalogPrice: number;
  packLadder?: LadderProduct;
}

/**
 * size-ratchet extraction out of edit-items.tsx's `addPickedToDraft`: resolve
 * the draft key AND build the pure `apply(d)` updater for one pick, in a
 * single call — everything about a pick that does NOT need React state
 * (`setDraft`/`draftRef`/`confirm`, which stay in the screen).
 *
 * units_v1 (SA-085i): a piece scan on an already unit-sold line adds a whole
 * unit — the caller confirms before committing when `existingLabel` comes
 * back set. Found by VALUE (productId + unitLabel), never a productId-keyed
 * lookup (B775/SA-108) — `resolveDraftKeyForPick` deliberately EXCLUDES a
 * unit-labeled line from its own match, so this line's own key is resolved
 * separately here and reused for the confirmed add.
 */
export function resolvePickTarget(
  draft: Record<string, DraftItem>,
  input: ResolvePickTargetInput,
): {
  key: string;
  existingLabel?: string;
  apply: (d: Record<string, DraftItem>) => Record<string, DraftItem>;
} {
  const existingUnitEntry = Object.entries(draft).find(
    ([, it]) => it.productId === input.productId && it.unitLabel,
  );
  // SA-580b: the unit-label keying + confirm apply only to a UNIT scan on a BOXED product (same
  // rule as NewOrderScreen's needsUnitLabelConfirm); upb <= 1 behaves like a picker tap.
  const unitLabelScan = needsUnitLabelConfirm(
    input.level,
    { unitsPerBox: input.unitsPerBox },
    existingUnitEntry?.[1].unitLabel,
  );
  const existingLabel = unitLabelScan ? (existingUnitEntry?.[1].unitLabel ?? undefined) : undefined;
  const key =
    unitLabelScan && existingUnitEntry
      ? existingUnitEntry[0]
      : resolveDraftKeyForPick(draft, input.productId, null);
  const apply = (d: Record<string, DraftItem>) =>
    applyPickToDraft(d, key, {
      productId: input.productId,
      unitsPerBox: input.unitsPerBox,
      startPrice: input.startPrice,
      catalogPrice: input.catalogPrice,
      name: input.name,
      unit: input.unit,
      level: input.level,
      kind: input.kind,
      packLadder: input.packLadder,
    });
  return { key, existingLabel, apply };
}

/**
 * BUY_N_GET_M free units for THIS draft row, rescaled to the qty now on screen
 * (shared helper, same rule as the invoice edit form and the server's
 * `rescaleBogoFreeUnits` fallback). A pending SUBSTITUTION earns nothing — the
 * snapshot belongs to the product being replaced, and undoing it restores them.
 */
export function draftFreeUnits(
  item:
    | Pick<DraftItem, "substituteProductId" | "promoFreeUnits" | "promoBaseUnits" | "boxes" | "qty">
    | undefined,
): number {
  if (!item) return 0;
  if (item.substituteProductId) return 0;
  return editedLineFreeUnits({
    promoFreeUnits: item.promoFreeUnits,
    promoBaseUnits: item.promoBaseUnits,
    boxes: item.boxes ?? null,
    qty: item.qty,
  });
}

/** Everything the operator has staged on the editor, in one shape. */
export interface StagedEdit {
  draft: Record<string, DraftItem>;
  unlisted: readonly UnlistedDraft[];
  pendingDeletes: readonly string[];
  selectedCreditIds: readonly string[];
  creditsTouched: boolean;
  /** `lineId ?? productId` of every line acked as "sell anyway" below the floor. */
  floorAcked: readonly string[];
}

// ─── What Save sends ─────────────────────────────────────────────────────────

/** A server line as the editor reads it back (only the fields the diff uses). */
export interface BaselineLine {
  id: string;
  productId?: string | null;
  qty: number | string;
  unitPrice: number | string;
  name?: string | null;
  notes?: string | null;
  status?: string | null;
  overrideReason?: string | null;
  /** units_v1 (SA-085f MEDIUM #4): present only on a unit-sold line — see `orderOriginals`. */
  unitLabel?: string | null;
  boxes?: number | null;
  unitsPerBox?: number | null;
}

export interface BaselineOrderLike {
  id?: string;
  updatedAt?: string | null;
  lineItems?: readonly BaselineLine[] | null;
}

/**
 * The order's non-cancelled lines as `buildOrderItemDiff` compares against.
 * Exported so the dirty check and the save share ONE derivation — a second
 * hand-rolled comparison is how "Save changes" and "are there changes?" drift.
 *
 * SA-085f MEDIUM #4: `qty` here must be on the SAME basis `hydrateFromOrder` normalizes the
 * draft to — the unit COUNT for a unit-sold line (`li.boxes ?? li.qty`, matching the server's
 * pack-piece storage convention), never the raw `li.qty` (total base pieces, e.g. 480 for 2
 * Cases). Comparing an un-normalized 480 against the draft's normalized 2 would read every
 * UNTOUCHED unit line as "changed" and send a spurious UPDATE on every save.
 */
export function orderOriginals(order: BaselineOrderLike | null | undefined): OriginalLine[] {
  return (order?.lineItems ?? [])
    .filter((li) => li.status !== "CANCELLED")
    .map((li) => ({
      id: li.id,
      productId: li.productId ?? null,
      qty: li.unitLabel ? (unitLineCount(li) ?? 0) : toNumber(li.qty),
      unitPrice: toNumber(li.unitPrice),
      name: li.name ?? null,
      notes: li.notes ?? null,
      overrideReason: li.overrideReason ?? null,
    }));
}

/**
 * EXACTLY the mapping the screen's `save()` used to inline: draft rows to
 * `DiffCatalogLine`, unlisted rows to `DiffUnlistedLine`, then
 * `buildOrderItemDiff` with the explicit trash set and no pending cancels.
 * `save()` now calls this, so the dirty check below can never claim a change
 * the payload doesn't carry (or miss one it does).
 */
export function stagedDiffItems(
  staged: Pick<StagedEdit, "draft" | "unlisted" | "pendingDeletes">,
  originals: OriginalLine[],
): UpdateOrderItemInput[] {
  const catalog: DiffCatalogLine[] = Object.values(staged.draft).map((i) => ({
    lineId: i.lineId,
    productId: i.productId,
    qty: effectiveQty(i, i.unitsPerBox),
    boxes: i.boxes ?? null,
    pieces: i.pieces ?? null,
    boxSplit: !!i.boxSplit,
    unitPrice: i.unitPrice,
    // units_v1: a unit-sold NEW line's override-vs-normal comparison (buildOrderItemDiff's
    // `overridden` check) must use THAT unit's own resolved price, never the pack's
    // `catalogPrice` — see lib/unit-options.ts#unitPriceBase.
    basePrice: unitPriceBase(i, i.catalogPrice),
    overrideReason: i.overrideReason,
    substituteProductId: i.substituteProductId,
    notes: i.notes,
    unitLabel: i.unitLabel ?? null,
  }));
  const unlistedLines: DiffUnlistedLine[] = staged.unlisted.map((u) => ({
    lineId: u.lineId,
    name: u.name,
    qty: u.qty,
    unitPrice: u.unitPrice,
    notes: u.notes,
  }));
  return buildOrderItemDiff({
    catalog,
    unlisted: unlistedLines,
    originals,
    pendingDeletes: [...staged.pendingDeletes],
    pendingCancels: [],
  });
}

/**
 * #2231 / SA-388: names of LOCKED unit lines (`needsRepair`) the operator has edited. The
 * diff can't carry them (no derivable count, qty 0 skips the UPDATE), so Save must refuse
 * with "needs repair" and send nothing rather than drop the edit or guess a count. Removing
 * the line is fine — it leaves the draft, and a DELETE needs no count.
 */
export function repairBlockedLines(
  draft: Record<string, DraftItem>,
  originals: OriginalLine[],
): string[] {
  const byId = new Map(originals.map((o) => [o.id, o]));
  return Object.values(draft)
    .filter((i) => {
      const o = i.needsRepair && i.lineId ? byId.get(i.lineId) : undefined;
      if (!o) return false;
      return (
        i.qty !== o.qty ||
        Math.abs(i.unitPrice - o.unitPrice) > 0.0001 ||
        (i.notes ?? "").trim() !== (o.notes ?? "").trim() ||
        (i.overrideReason ?? null) !== (o.overrideReason ?? null) ||
        !!i.substituteProductId
      );
    })
    .map((i) => i.name);
}

/** True when Save would send at least one line action. */
export function hasUnsavedItemEdits(
  staged: Pick<StagedEdit, "draft" | "unlisted" | "pendingDeletes">,
  originals: OriginalLine[],
): boolean {
  return stagedDiffItems(staged, originals).length > 0;
}

/**
 * Items OR a touched credit selection — the leave/flush trigger. `save()`
 * still sends when `items.length === 0 && creditsTouched`, so a credits-only
 * edit is unsaved work too.
 */
export function hasUnsavedWork(staged: StagedEdit, originals: OriginalLine[]): boolean {
  return staged.creditsTouched || hasUnsavedItemEdits(staged, originals);
}

/**
 * Whether the editor's `[order]` hydration effect may overwrite the staged edit
 * with what the server just returned.
 *
 * The effect used to be unconditional, so ANY background refetch of the order
 * (a window focus, a cache invalidation, a socket push) re-ran `setDraft` from
 * the server and silently discarded staged work — and because the restore
 * effect is one-shot it could not put it back, while the autosave effect then
 * saw a clean draft and took its `removeItem` branch, destroying the on-disk
 * copy too. Three rules, in order:
 *
 *  - `!hydrated` — the FIRST hydration always runs. It has to: on the render
 *    where `order` first arrives the draft is still empty, so `dirty` is TRUE
 *    (every server line reads as a removal through `buildOrderItemDiff`'s
 *    dropped-line rule) and a bare dirty check would leave the editor blank.
 *  - `justSaved` — the refetch that follows a successful save IS the new truth;
 *    the staged edit is already on the server.
 *  - otherwise a refetch may only re-hydrate a CLEAN editor.
 */
export function shouldRehydrateFromOrder(input: {
  /** This order has already been hydrated into the draft once. */
  hydrated: boolean;
  /** `hasUnsavedWork` as of the render that preceded the effect. */
  dirty: boolean;
  /** A save has succeeded on this screen (the screen's `savedRef`). */
  justSaved: boolean;
}): boolean {
  if (!input.hydrated) return true;
  if (input.justSaved) return true;
  return !input.dirty;
}

// ─── The on-device snapshot ──────────────────────────────────────────────────

// Bumped 1→2 (B775/SA-108): pre-fix snapshots stored `draft` keyed by
// `productId`, which collides two same-product lines into one entry. A v1
// snapshot must be discarded, never restored, so it can't resurrect that bug.
export const EDIT_ITEMS_SNAPSHOT_VERSION = 2;
/** Same TTL shape as `lib/list-ui-snapshot.ts`; a day-old staged edit is stale. */
export const EDIT_ITEMS_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
/** Idle debounce before a snapshot write, matching the stock-count autosave. */
export const EDIT_ITEMS_AUTOSAVE_DEBOUNCE_MS = 900;

/**
 * Fingerprint of the server lines the staged edit was diffed against: the
 * non-CANCELLED lines, sorted by id, over exactly the fields
 * `buildOrderItemDiff` measures a change on. Numbers are normalised (and the
 * price rounded) so `"8.00"` and `8` fingerprint identically.
 *
 * This is the staleness gate rather than `order.updatedAt`, which bumps on
 * order-level writes (a status change, a fulfil path) that do not invalidate
 * a staged LINE edit at all.
 */
export function snapshotBaseline(order: BaselineOrderLike | null | undefined): string {
  return (order?.lineItems ?? [])
    .filter((li) => li.status !== "CANCELLED")
    .map((li) => ({
      id: String(li.id ?? ""),
      productId: li.productId ?? "",
      qty: toNumber(li.qty),
      unitPrice: roundMoney(toNumber(li.unitPrice)),
      name: (li.name ?? "").trim(),
      notes: (li.notes ?? "").trim(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => `${l.id}|${l.productId}|${l.qty}|${l.unitPrice}|${l.name}|${l.notes}`)
    .join(";");
}

export interface EditItemsSnapshot {
  v: number;
  orderId: string;
  savedAt: number;
  baseline: string;
  /** Diagnostics only — never the staleness gate (see `snapshotBaseline`). */
  orderUpdatedAt?: string | null;
  draft: Record<string, DraftItem>;
  unlisted: UnlistedDraft[];
  pendingDeletes: string[];
  selectedCreditIds: string[];
  creditsTouched: boolean;
  floorAcked: string[];
}

export function makeEditItemsSnapshot(args: {
  orderId: string;
  staged: StagedEdit;
  baseline: string;
  orderUpdatedAt?: string | null;
  now?: number;
}): EditItemsSnapshot {
  return {
    v: EDIT_ITEMS_SNAPSHOT_VERSION,
    orderId: args.orderId,
    savedAt: args.now ?? Date.now(),
    baseline: args.baseline,
    orderUpdatedAt: args.orderUpdatedAt ?? null,
    draft: args.staged.draft,
    unlisted: [...args.staged.unlisted],
    pendingDeletes: [...args.staged.pendingDeletes],
    selectedCreditIds: [...args.staged.selectedCreditIds],
    creditsTouched: args.staged.creditsTouched,
    floorAcked: [...args.staged.floorAcked],
  };
}

export function serializeEditItemsSnapshot(snapshot: EditItemsSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Parse a stored snapshot. NEVER throws: anything unparseable, of the wrong
 * version, or structurally wrong returns null, because a corrupt blob on disk
 * must degrade to "no restore offered", never to a crashed editor.
 */
/**
 * SA-085h LOW: a unit-sold DraftItem still carrying `boxes` (an on-device snapshot saved by a
 * build from before hydrateFromOrder normalized qty to the COUNT — a 2-Case line stored as
 * qty:480, boxes:2) is un-normalized. Fold it to the SAME count basis hydrateFromOrder always
 * produces, so a restored snapshot's stepper/display/diff agree with a freshly-hydrated line.
 */
function normalizeUnitLineQty(item: DraftItem): DraftItem {
  if (!item.unitLabel || item.boxes == null) return item;
  return { ...item, qty: item.boxes, boxes: undefined, pieces: undefined, boxSplit: false };
}

export function deserializeEditItemsSnapshot(
  raw: string | null | undefined,
): EditItemsSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const s = parsed as Partial<EditItemsSnapshot>;
  if (s.v !== EDIT_ITEMS_SNAPSHOT_VERSION) return null;
  if (typeof s.orderId !== "string" || !s.orderId) return null;
  if (typeof s.savedAt !== "number" || !Number.isFinite(s.savedAt)) return null;
  if (typeof s.baseline !== "string") return null;
  if (!s.draft || typeof s.draft !== "object" || Array.isArray(s.draft)) return null;
  if (!Array.isArray(s.unlisted)) return null;
  if (!Array.isArray(s.pendingDeletes)) return null;
  if (!Array.isArray(s.selectedCreditIds)) return null;
  if (!Array.isArray(s.floorAcked)) return null;
  return {
    v: s.v,
    orderId: s.orderId,
    savedAt: s.savedAt,
    baseline: s.baseline,
    orderUpdatedAt: s.orderUpdatedAt ?? null,
    draft: Object.fromEntries(
      Object.entries(s.draft as Record<string, DraftItem>).map(([id, item]) => [
        id,
        normalizeUnitLineQty(item),
      ]),
    ),
    unlisted: s.unlisted as UnlistedDraft[],
    pendingDeletes: s.pendingDeletes as string[],
    selectedCreditIds: s.selectedCreditIds as string[],
    creditsTouched: !!s.creditsTouched,
    floorAcked: s.floorAcked as string[],
  };
}

/**
 * A snapshot is stale — never auto-applied, only offered for discard — when
 * the order is unknown, the ids disagree, the TTL has run out, or the server
 * lines it was diffed against have changed underneath it.
 */
export function isSnapshotStale(
  snapshot: EditItemsSnapshot | null | undefined,
  order: BaselineOrderLike | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!snapshot) return true;
  if (snapshot.v !== EDIT_ITEMS_SNAPSHOT_VERSION) return true;
  if (!order) return true;
  if (order.id && order.id !== snapshot.orderId) return true;
  if (now - snapshot.savedAt >= EDIT_ITEMS_SNAPSHOT_TTL_MS) return true;
  return snapshotBaseline(order) !== snapshot.baseline;
}

/**
 * The storage key. User-scoped (one operator's staged edit must never surface
 * under the next login — B136/B137/B140) and ORDER-scoped (the same component
 * is mounted by the operator route and the driver stop route, and an operator
 * edits several orders per session). The `anon` fallback mirrors
 * `lib/user-scoped-storage.ts` WITHOUT importing it: that module imports
 * AsyncStorage at the top level, which this module may not.
 */
export function editItemsSnapshotKey(orderId: string, userId: string | null | undefined): string {
  return `${editItemsSnapshotUserPrefix(userId)}${orderId}`;
}

/**
 * The shared stem of every staged-edit key. Bumped with
 * {@link EDIT_ITEMS_SNAPSHOT_VERSION} whenever the stored shape changes.
 */
export const EDIT_ITEMS_SNAPSHOT_KEY_PREFIX = "rf.edit-items.v1";

/**
 * Every staged-edit key one user can own, as a prefix.
 *
 * This snapshot is a KEYSPACE, not a single blob: one key PER ORDER, so
 * sign-out cannot delete it with a `clearUserScopedStorage(NAME, userId)` call
 * the way the zustand-persisted stores do (RULINGS R1). `lib/session-teardown.ts`
 * enumerates `AsyncStorage.getAllKeys()` and removes everything under this
 * prefix instead, so one operator's staged order edit can never surface under
 * the next login on a shared device (the B136/B137/B140 class).
 *
 * Ends with the separator on purpose — `"...:u1:"` must never match a user id
 * that merely starts with `u1`.
 */
export function editItemsSnapshotUserPrefix(userId: string | null | undefined): string {
  return `${EDIT_ITEMS_SNAPSHOT_KEY_PREFIX}:${userId ?? "anon"}:`;
}

// ─── The picker's pull-out drawer ────────────────────────────────────────────

/**
 * The drawer's rows, newest-scanned first — `lib/scan-tray.ts#trayRowsFrom`
 * verbatim, so `<ScanTray/>` renders the order-edit surface with the exact
 * derivation the sale builders use.
 *
 * `overridable: () => true` is correct HERE (unlike NewOrderScreen's
 * `isSpecialFor` gate): on the EDIT surface the line's stored `unitPrice` is
 * what the order actually charges — it came back from the server on that line.
 * `freeUnitsFor` threads the screen's BUY_N_GET_M netting in, so a promo line's
 * drawer subtotal matches its card and the footer.
 */
export function draftTrayRows(input: {
  draft: Record<string, DraftItem>;
  unlisted: readonly UnlistedDraft[];
  scanOrder: readonly string[];
}): TrayRow[] {
  return trayRowsFrom({
    items: input.draft,
    unlisted: input.unlisted.map((u) => ({
      id: u.id,
      name: u.name,
      qty: u.qty,
      unitPrice: u.unitPrice,
    })),
    scanOrder: input.scanOrder,
    lookup: (id) => {
      const it = input.draft[id];
      return it ? { id, name: it.name, unitsPerBox: it.unitsPerBox ?? null } : undefined;
    },
    // SA-085h: the SAME comparison base every other reader of this line uses — a unit-sold
    // line's reference price is its own resolved level, never the pack's catalogPrice. (This
    // is the fallback the tray subtotal uses only when overridable is false or unitPrice is
    // unset; a DraftItem always has both, so it never actually reaches this value today —
    // fixed for consistency with the create screen's identical tray.)
    priceFor: (product) => {
      const item = input.draft[product.id];
      return item ? unitPriceBase(item, item.catalogPrice) : 0;
    },
    overridable: () => true,
    freeUnitsFor: (id) => draftFreeUnits(input.draft[id]),
  });
}

/** The collapsed drawer is a grab handle and nothing else. */
export const PICKER_TRAY_HANDLE_HEIGHT = 56;

/**
 * Expanded drawer height that never covers the camera's viewfinder.
 *
 * `components/BarcodeScanner.tsx` fixes that geometry: the clear window is
 * `SCREEN_WIDTH * 0.7` tall and its top dark band is
 * `(SCREEN_HEIGHT - WINDOW_SIZE) / 2 - 40`, so the viewfinder's bottom edge
 * sits at `topBand + WINDOW_SIZE` and everything below it is the camera's dark
 * hint band — which is exactly the space the drawer may take.
 */
export function pickerTrayExpandedHeight(win: { width: number; height: number }): number {
  const scanWindow = win.width * 0.7;
  const viewfinderBottom = (win.height - scanWindow) / 2 - 40 + scanWindow;
  // FLOOR, not round: at 390x844 the free band is 325.5px and `Math.round`
  // would return 326 — half a pixel of drawer over the viewfinder's edge.
  return Math.max(
    200,
    Math.min(Math.round(win.height * 0.55), Math.floor(win.height - viewfinderBottom)),
  );
}

/**
 * `appliedCreditNotes` for a touched credits section. MONEY: previously-linked credits ROUND-TRIP
 * their stored per-credit amount (a bare {creditNoteId} re-syncs as "up to remaining"); newly
 * selected ones send no amount. Moved verbatim out of the screen (size ratchet, row 262).
 */
export function appliedCreditNotesPayload(
  selectedCreditIds: string[],
  order: unknown,
): { creditNoteId: string; amount?: number }[] {
  return selectedCreditIds.map((cnId) => {
    const stored = ((order as any)?.orderCreditNotes ?? []).find(
      (oc: any) => oc.creditNoteId === cnId,
    );
    return stored?.amount != null
      ? { creditNoteId: cnId, amount: toNumber(stored.amount) }
      : { creditNoteId: cnId };
  });
}
