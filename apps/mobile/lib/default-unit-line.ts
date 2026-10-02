import type { ProductUnitLevel } from "@routeflow/types";
import type { LineState } from "./cart-line-state";
import { sameScanCode } from "./scan-accept-guard";
import {
  isUnitPending,
  packQtyForTaps,
  mayMergeResolved,
  pendingResolvePlan,
  pendingScanDecision,
  pendingTapCount as sharedPendingTapCount,
  refreshUnitsAnswer as refreshUnitsAnswerShared,
  refusesPendingEdit as sharedRefusesPendingEdit,
  type LadderProduct,
  type PendingBlockReason,
  type PendingEditIntent,
  type PendingScanDecision,
} from "@routeflow/pricing";
import { defaultStartOption, type UnitOption } from "./unit-options";

/**
 * SA-626c (tier 1 money): the default selling unit belongs to the LINE, never to a mounted sheet. A line flagged
 * `startOnDefaultUnit` (a shared-code scan, a picker "+", the "Which one?" sheet) is moved onto the product's
 * default unit by THIS module, once the ladder is known, so the tray and Confirm read a stored unit. The cart row's
 * UnitPickerRow still resolves through the same functions, so there is one rule and no second copy.
 */

/** #2865 (SA-632 H2): the visible refusal of a scan of a DIFFERENT level while a line's default unit is loading. */
export const UNITS_LOADING_SCAN_MESSAGE = "Units are still loading. Scan again in a moment";

/** The ONE writer of a chosen unit (the sheet's onChange and the default start). The pack is `option.value === ""`. */
export function applyUnitOption(
  prev: LineState,
  option: UnitOption,
  unitsPerBox?: number | string | null,
): LineState {
  const isPack = option.value === "";
  // A REMEMBERED pack price (history pre-fill) is stashed while the line sells by a unit and re-applied when the buyer
  // explicitly picks the pack again; an operator-typed price is cleared by a unit choice, as always (SA-626d).
  const remembered = prev.priceSource === "history" && prev.unitPrice != null && !prev.unitLabel;
  const restore = isPack && prev.packUnitPrice != null;
  const sameUnit = !isPack && prev.unitLabel === option.value;
  return {
    ...prev,
    unitLabel: isPack ? undefined : option.value,
    unitBasePrice: isPack ? undefined : option.price,
    unitFactor: isPack ? undefined : option.factorToBase,
    // any unit choice CONSUMES the default-start flag (a cart re-open never re-applies it, Opus #2865 B2)
    startOnDefaultUnit: undefined,
    pendingTaps: undefined,
    pendingCode: undefined,
    // A still-pending line keeps its count (N fast adds = N of the unit); re-applying the unit the line ALREADY holds (a
    // stale sheet/picker after the resolver ran) keeps its quantity; any other choice resets to 1, as always.
    qty: sameUnit
      ? prev.qty
      : !isPack && isPendingDefaultUnit(prev)
        ? pendingTapCount(prev, unitsPerBox)
        : 1,
    boxes: undefined,
    pieces: undefined,
    unitPrice: sameUnit ? prev.unitPrice : restore ? prev.packUnitPrice : undefined,
    priceSource: sameUnit ? prev.priceSource : restore ? "history" : undefined,
    packUnitPrice: isPack ? undefined : remembered ? prev.unitPrice : prev.packUnitPrice,
  };
}

/** Fast adds before the ladder loaded: N adds = N of the default unit. A boxed product's qty is total pieces. */
export function pendingTapCount(line: LineState, unitsPerBox?: number | string | null): number {
  // #2865 case c: the PENDING TAP COUNT is recorded explicitly, never inferred from a quantity in a guessed unit.
  const upb = Number(unitsPerBox ?? 0);
  return sharedPendingTapCount(line.pendingTaps, upb > 1 ? Math.round(line.qty / upb) : line.qty);
}

/**
 * Still waiting for its default unit: the flag only holds while qty is untouched and the operator typed no price. A
 * REMEMBERED price (`priceSource: "history"`) is the system's pre-fill, not an operator shape, so it does not decide
 * the unit (owner ruling SA-626d).
 */
export function isPendingDefaultUnit(line: LineState | undefined): boolean {
  if (!line) return false;
  return isUnitPending(pendingFacts(line));
}

/** The line facts the shared rules read. On mobile the flag holds only while it equals the line's qty. */
function pendingFacts(line: LineState) {
  return {
    startOnDefaultUnit: line.startOnDefaultUnit,
    qty: line.qty,
    // a typed operator price shapes the line (a remembered "history" price is the system's pre-fill: SA-626d)
    operatorPrice:
      line.priceSource === "operator" || (line.unitPrice != null && line.priceSource !== "history"),
  };
}

/**
 * #2865 case c (SA-632): is this edit REFUSED because the line is pending? The shared rule (@routeflow/pricing), applied
 * IN THE LOGIC (a quantity, a typed price, a units total or a stepper increment come back unchanged). Only a default-start
 * TAP may add to a pending line.
 */
export function refusesLineEdit(prev: LineState | undefined, intent: PendingEditIntent): boolean {
  return !!prev && sharedRefusesPendingEdit(pendingFacts(prev), intent);
}

/**
 * #2865 (F3): does this scan map to the DEFAULT unit of a pending line? Yes when it is flagged default (a shared code), OR
 * when it repeats the code that CREATED the line (the same label, so the same level, however the row data looks on a later
 * lookup). A different code on a pending line stays refused.
 */
export function scanMapsToDefault(
  prev: LineState | undefined,
  dflt: boolean | undefined,
  code?: string,
): boolean {
  if (dflt) return true;
  return !!code && !!prev?.pendingCode && sameScanCode(code, prev.pendingCode);
}

/** A STAFF default-unit tap (flagged, or a repeat of the creating code) on a still-pending line: it only counts. */
export function isPendingTap(
  prev: LineState | undefined,
  dflt: boolean | undefined,
  code: string | undefined,
  role?: string | null,
): boolean {
  return (
    isStaffRole(role) && !!prev && isPendingDefaultUnit(prev) && scanMapsToDefault(prev, dflt, code)
  );
}

/** A scan landing on an existing line: a tap (default unit), refused (a different level while pending), or a plain add. */
export function scanDecisionFor(
  prev: LineState | undefined,
  mapsToDefault: boolean,
): PendingScanDecision {
  return pendingScanDecision(prev && pendingFacts(prev), { mapsToDefault });
}

/**
 * Only STAFF may sell by a unit (the server's assertMayUseUnits rejects a unit line from any other role), so a DRIVER or
 * any non-staff role never starts on a default unit: the pack is their only legal line (SA-626f).
 */
export function isStaffRole(role?: string | null): boolean {
  return role === "OPERATOR" || role === "TENANT_ADMIN";
}

/** Does this add keep (or start) the default-start flag? A STAFF default-start add to a NEW or still-pending line only. */
export function keepsDefaultStart(
  prev: LineState | undefined,
  dflt?: boolean,
  role?: string | null,
): boolean {
  return !!dflt && isStaffRole(role) && (!prev || isPendingDefaultUnit(prev));
}

/**
 * #2865 (N3): a pending line whose default unit IS the pack (no flagged non-pack default, units off, a role that never sells
 * by a unit) settles on the PACK with the TAP COUNT it recorded: N taps = N packs, never one. The shared pricing rule decides
 * the quantity; the flag, the count and the creating code are consumed.
 */
export function settleOnPack(line: LineState, unitsPerBox?: number | string | null): LineState {
  // the pack size: the product's, else what the line itself holds (a case-packed line carries boxes + total pieces)
  const upb = Number(unitsPerBox ?? 0) || (line.boxes ? line.qty / line.boxes : 0);
  const pack = packQtyForTaps(pendingTapCount(line, upb), upb);
  return {
    ...line,
    qty: pack.qty,
    boxes: pack.boxes,
    pieces: pack.pieces,
    startOnDefaultUnit: undefined,
    pendingTaps: undefined,
    pendingCode: undefined,
  };
}

/** The line once its ladder is known: on the flagged default unit, or (nothing flagged/offered) left on the pack. */
export function startLineOnDefault(
  line: LineState,
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  tier: number,
): LineState {
  if (!isPendingDefaultUnit(line)) return line;
  const start = defaultStartOption(product, units, tier, { hasUnit: !!line.unitLabel });
  if (!start) return settleOnPack(line, product.unitsPerBox);
  return applyUnitOption(line, start, product.unitsPerBox);
}

export interface DefaultUnitDeps {
  /** Non-staff never start on a default unit and make NO read (SA-626f). */
  isStaff: boolean;
  /** `flag.units_v1`: with it off there is no ladder, so the pack is the only unit. */
  unitsEnabled: boolean;
  /** False while the subscription answer is still loading: "off" is not yet known, so nothing may be resolved. */
  unitsKnown: boolean;
  getUnits: (productId: string) => Promise<ProductUnitLevel[]>;
  productFor: (productId: string) => LadderProduct | undefined;
  tierFor: (productId: string) => number;
}

/** "Try again" on the blocked message: the shared rule (@routeflow/pricing), kept under its old name for callers. */
export const refreshUnitsAnswer: (
  deps: DefaultUnitDeps,
  refetch: () => Promise<{ isSuccess: boolean; flags: readonly string[] }>,
  unitsFlag: string,
) => Promise<DefaultUnitDeps> = refreshUnitsAnswerShared;

/**
 * Resolves every pending line, fetching the ladder when it is not cached. A line whose ladder cannot be loaded (or
 * whose product record is missing) is reported in `blocked` and left untouched: the caller refuses to submit rather
 * than send the pack/case by default.
 */
export async function resolvePendingDefaultUnits(
  items: Record<string, LineState>,
  deps: DefaultUnitDeps,
): Promise<{
  items: Record<string, LineState>;
  blocked: string[];
  reasons: Record<string, PendingBlockReason>;
}> {
  const next = { ...items };
  const blocked: string[] = [];
  const reasons: Record<string, PendingBlockReason> = {};
  const block = (id: string, reason: PendingBlockReason) => {
    blocked.push(id);
    reasons[id] = reason;
  };
  for (const [id, line] of Object.entries(items)) {
    if (!isPendingDefaultUnit(line)) continue;
    // #2865 (SA-632 M4): the per-line plan is the shared rule (@routeflow/pricing).
    const product = deps.productFor(id);
    const plan = pendingResolvePlan({ ...deps, productKnown: !!product });
    if (plan.plan === "settle") {
      next[id] = settleOnPack(line, deps.productFor(id)?.unitsPerBox);
      continue;
    }
    if (plan.plan === "blocked") {
      block(id, plan.reason);
      continue;
    }
    try {
      next[id] = startLineOnDefault(line, product!, await deps.getUnits(id), deps.tierFor(id));
    } catch {
      block(id, "ladder-failed");
    }
  }
  return { items: next, blocked, reasons };
}

const UNIT_FIELDS = [
  "pendingTaps",
  "pendingCode",
  "unitLabel",
  "unitBasePrice",
  "unitFactor",
  "startOnDefaultUnit",
  "qty",
  "boxes",
  "pieces",
  "unitPrice",
  "priceSource",
  "packUnitPrice",
] as const;
function pickUnitFields(line: LineState): Partial<LineState> {
  return Object.fromEntries(UNIT_FIELDS.map((k) => [k, line[k]])) as Partial<LineState>;
}

/** An async resolve never overwrites what the buyer did meanwhile: apply it only to a still-pending line at the same qty. */
export function mergeResolvedDefaults(
  cur: Record<string, LineState>,
  before: Record<string, LineState>,
  done: Record<string, LineState>,
): Record<string, LineState> {
  let out = cur;
  for (const id of Object.keys(done)) {
    const c = cur[id];
    if (
      !mayMergeResolved({
        cur: c && pendingFacts(c),
        curCount: c ? pendingTapCount(c) : 0,
        beforeCount: before[id] ? pendingTapCount(before[id]) : -1,
        changed: done[id] !== before[id],
      })
    )
      continue;
    out = out === cur ? { ...cur } : out;
    // only the unit fields: a note (or any other edit) typed while the units loaded must survive the merge
    out[id] = { ...c!, ...pickUnitFields(done[id]!) };
  }
  return out;
}
