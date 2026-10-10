/**
 * Shared line-item subtotal calculation + money helpers.
 *
 * `pricePerUnit` on a Product is the canonical SELLING-UNIT price the operator
 * entered. For products with `unitsPerBox > 1` the canonical selling unit is
 * one BOX (because operators almost always quote and price by the case);
 * issuing loose pieces is prorated as `pricePerUnit / unitsPerBox`.
 *
 * Historically the codebase computed `subtotal = pricePerUnit * qty` where
 * `qty` was already expanded to total pieces (boxes × unitsPerBox + pieces).
 * That over-charged boxed items by a factor of `unitsPerBox` (a single $43.75
 * box of 6 came out as $262.50). This helper centralises the correct formula
 * so orders, invoices, estimates, vendor bills and the buyer cart all agree.
 *
 * MONEY DISCIPLINE: every monetary result returned from here is rounded to
 * cents via {@link roundMoney}. Callers MUST also wrap their own aggregations
 * (sum of lines, tax, grand total) in {@link roundMoney} so floating-point
 * drift never reaches the database. This package (`@routeflow/pricing`) is the
 * single source imported by api, web and mobile — there are no mirrors.
 */

/**
 * Round a monetary amount to 2 decimal places (cents), guarding against binary
 * floating-point drift (e.g. `0.1 + 0.2`). This is the single rounding policy
 * for the whole money pipeline — half-away-from-zero at the cent.
 *
 * REG-B122: the previous nudge (`+ Number.EPSILON` before scaling and
 * rounding) added only ~2.22e-16 — far below one half-ULP of any double
 * >= 2 — so it was a no-op for ordinary money values, and every input whose
 * 3rd decimal digit is exactly 5 (2.135, 4.015, 7.5% of $29.00, ...) rounded
 * DOWN instead of the documented half-away-from-zero. `toFixed(4)` fixes this
 * by a different mechanism: it re-renders the scaled value through DECIMAL
 * string formatting, which snaps away the noisy binary tail a double leaves
 * behind (e.g. `2.135 * 100` is actually `213.49999999999997`) back to the
 * base-10 digits the literal means (`"213.5000"`) BEFORE `Math.round` sees
 * it — a fix that holds regardless of how far the true value sits from its
 * nearest representable double, unlike a fixed epsilon nudge. `Math.round`
 * itself is half-up for positive numbers, so the sign is split off first.
 */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const cents = Math.round(Number((Math.abs(n) * 100).toFixed(4)));
  return (sign * cents) / 100;
}

/**
 * True when `n` is a finite amount in whole cents — the ONE predicate for "is this a cents
 * amount" (#2695, SA-557c). Defined by {@link roundMoney}, so it agrees with every rounded write:
 * `19.99` passes even though `19.99 * 100` is `1998.9999999999998` in floats (a hand-rolled
 * `Math.round(n * 100) === n * 100` refuses 1,146 of the 10,001 cent values in $0–$100).
 * Sign is not its concern: a caller that needs ≥ 0 checks that itself.
 */
export function isWholeCents(n: number): boolean {
  return Number.isFinite(n) && roundMoney(n) === n;
}

export interface NormalizedQty {
  /** Whole boxes (null for non-boxed products / no split). */
  boxes: number | null;
  /** Loose pieces below a full box (null for non-boxed products / no split). */
  pieces: number | null;
  /** Total quantity in pieces — always an integer. */
  qty: number;
}

/**
 * Force INTEGER boxes/pieces/qty and roll any loose pieces that reach a full
 * box up into the box count. Single source of truth for quantity hygiene so the
 * UI can never persist fractional units or a stale `pieces >= unitsPerBox`.
 *
 * - Boxed product (`unitsPerBox > 1`): derives a canonical `{boxes, pieces}`
 *   from whichever the caller supplied — an explicit boxes/pieces split OR a
 *   raw piece `qty` — and guarantees `pieces < unitsPerBox`.
 * - Non-boxed product: returns `{boxes: null, pieces: null, qty}` with `qty`
 *   coerced to a non-negative integer.
 */
export function normalizeBoxesPieces(input: {
  boxes?: number | null;
  pieces?: number | null;
  qty?: number | null;
  unitsPerBox?: number | null;
}): NormalizedQty {
  const upb = Math.trunc(Number(input.unitsPerBox ?? 0));
  const hasBoxPackaging = upb > 1;

  if (hasBoxPackaging) {
    const splitProvided = input.boxes != null || input.pieces != null;
    const totalPieces = splitProvided
      ? Math.trunc(Number(input.boxes ?? 0)) * upb + Math.trunc(Number(input.pieces ?? 0))
      : Math.trunc(Number(input.qty ?? 0));
    const safeTotal = Math.max(0, totalPieces);
    return {
      boxes: Math.floor(safeTotal / upb),
      pieces: safeTotal % upb,
      qty: safeTotal,
    };
  }

  const qty = Math.max(0, Math.trunc(Number(input.qty ?? 0)));
  return { boxes: null, pieces: null, qty };
}

/**
 * Recover a legacy line's pack size (`unitsPerBox`) from its OWN stored
 * boxes/pieces/qty split — never from the live product, which may have been
 * repacked since. A boxed line's `qty` is always `boxes * pack + pieces` (the
 * invariant `normalizeBoxesPieces` enforces going forward), so the pack is
 * just `(qty - pieces) / boxes` whenever that division lands on a whole
 * number greater than 1. Returns `null` whenever the split can't recover a
 * pack — no boxes, a non-integer quotient, or a quotient of exactly 1 (a
 * "pack of one" is indistinguishable from not boxed at all) — so the caller
 * falls back to its existing null-`unitsPerBox` behavior rather than guess.
 */
export function packFromOwnSplit(input: {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
}): number | null {
  const boxes = Number(input.boxes ?? 0);
  if (!(boxes > 0)) return null;
  const pieces = Number(input.pieces ?? 0);
  const qty = Number(input.qty ?? 0);
  const pack = (qty - pieces) / boxes;
  return Number.isInteger(pack) && pack > 1 ? pack : null;
}

/**
 * Does a stored box/piece split add up to its qty? True only when the pack is known and greater than 1 and
 * `boxes x pack + pieces === qty` (tolerance 1e-6 on qty). A split with no pack (null, 0 or 1) is never
 * "matching": it cannot be checked. ONE definition, used by the invoice edit plan and the invoice -> order
 * back-sync (SA-257), so a split one writes is never one the other would refuse.
 */
export function splitMatchesQty(input: {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}): boolean {
  const pack = Number(input.unitsPerBox ?? 0);
  if (!(pack > 1)) return false;
  const boxes = Number(input.boxes ?? 0);
  const pieces = Number(input.pieces ?? 0);
  return Math.abs(boxes * pack + pieces - Number(input.qty ?? 0)) < 1e-6;
}

export interface LineSubtotalInput {
  unitPrice: number;
  /**
   * B683: on a NON-boxed product this is genuinely pieces (the selling unit
   * IS the piece). On a BOXED product (`unitsPerBox > 1`) with no `boxes`/
   * `pieces` split, this is the legacy/lenient convention instead: `qty` is
   * the SELLING-UNIT (box) count and `unitPrice` the per-box price — NOT
   * pieces, despite the name. `computeLineSubtotal` cannot tell the two
   * conventions apart on its own; it trusts the caller. See
   * `computeLineSubtotal`'s own fallback-branch comment, and `lineAmbiguity`/
   * `buildLine`, which refuse this exact ambiguous shape going forward.
   */
  qty: number;
  /** Number of full boxes (only meaningful when unitsPerBox > 1). */
  boxes?: number | null;
  /** Loose pieces below a full box. */
  pieces?: number | null;
  /** Box size; null/1 means the product is sold as individual pieces. */
  unitsPerBox?: number | null;
  /**
   * Whole SELLING units made free by a BUY_N_GET_M promo (boxes for a boxed
   * line, pieces otherwise) — subtracted before pricing so the saving is
   * EXACT, never a rounded net-unit-price. Clamped so the line can never go
   * negative. Default 0: every existing call site is unaffected.
   */
  freeUnits?: number;
}

export function computeLineSubtotal(input: LineSubtotalInput): number {
  const { unitPrice, qty, boxes, pieces, unitsPerBox, freeUnits = 0 } = input;
  const free = Math.max(0, Math.trunc(Number(freeUnits) || 0));
  const upb = Number(unitsPerBox ?? 0);
  const hasBoxPackaging = upb > 1;
  const boxesPiecesProvided = boxes != null || pieces != null;

  if (hasBoxPackaging && boxesPiecesProvided) {
    // unitPrice is the BOX price. One box = unitPrice; loose pieces are prorated.
    const b = Number(boxes ?? 0);
    const p = Number(pieces ?? 0);
    const boxEquivalent = Math.max(0, b - free) + p / upb;
    return roundMoney(unitPrice * boxEquivalent);
  }

  // B683: two DIFFERENT shapes reach here, and this line prices them identically
  // (unitPrice * qty) without being able to tell them apart:
  //   - a genuinely non-boxed product (unitsPerBox <= 1): qty is pieces,
  //     unitPrice is per piece — the comment this replaced was accurate here.
  //   - a BOXED product (unitsPerBox > 1) whose caller sent a bare qty with no
  //     boxes/pieces split (the legacy/lenient/ambiguous shape `lineAmbiguity`
  //     and `buildLine` refuse going forward, B644/B682): qty is conventionally
  //     the SELLING-UNIT (box) count and unitPrice the per-box price — NEVER
  //     pieces. A caller needing an actual piece count for this shape (e.g. a
  //     regulated per-unit tax basis) must multiply by unitsPerBox itself; see
  //     manual-invoice-lines.ts's pieceQty for the pattern.
  return roundMoney(unitPrice * Math.max(0, qty - free));
}

/** Thrown by {@link computeLineSubtotalStrict} — see its doc comment. */
export class AmbiguousLineError extends Error {
  readonly code = "AMBIGUOUS_LINE" as const;

  constructor(message: string) {
    super(message);
    this.name = "AmbiguousLineError";
  }
}

/**
 * Pure ambiguity check for a line shape — no throw, no side effect. Returns the reason a shape is
 * ambiguous, or `null` when it's fine. {@link computeLineSubtotalStrict} throws when this is
 * non-null; a warn-phase caller (owner ruling 2026-09-21: warn-first, throw in its own diff) can
 * call this directly and just log the reason — there is no try/catch-and-swallow needed to get a
 * non-throwing form (Senior Architect review, HOLD 3, 2026-09-21).
 *
 * `qty`'s integer check applies ONLY when `unitsPerBox > 1` (a real box/piece count is always
 * whole). A non-boxed line's `qty` is `Decimal(10,3)` in the schema — a fractional selling
 * quantity (e.g. 1.5 kg) is legitimate and never flagged here (HOLD 1).
 *
 * Reasons: a boxed product (`unitsPerBox > 1`) with NEITHER `boxes` nor `pieces` given (the B644
 * shape: 6 boxes of 12 read as 72 x the BOX price); `pieces >= unitsPerBox` (a stale split that
 * should have rolled over via `normalizeBoxesPieces`); a non-integer `boxes`/`pieces`/boxed-`qty`;
 * or `boxes`/`pieces` given and their `boxes*unitsPerBox+pieces` disagrees with `qty`.
 */
/**
 * SA-077(2): a boxes/pieces split was given while NO pack resolves (`unitsPerBox` absent, 0 or 1).
 * Returns the reason, or null when the shape is fine.
 *
 * There is no denominator, so the split cannot be priced. Every consumer used to drop it silently
 * and charge `unitPrice * qty` — and on a line whose `unitPrice` is a CASE price that is the box
 * price charged per piece, the B717 family's defect. `buildLine` has refused this at its own choke
 * point since G1 (`./build-line.ts`), but `lineAmbiguity` did not, because every one of its box
 * checks is gated on `unitsPerBox > 1`. Exported so the ONE definition serves both the guard and
 * the API's 4xx, rather than being restated in a second place.
 *
 * Deliberately narrow: a split that contradicts itself on a line that DOES have a pack is NOT this
 * shape. That one prices from the split at the resolved pack (B717) and must not be refused.
 */
export function splitWithoutPack(input: {
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}): string | null {
  if (input.boxes == null && input.pieces == null) return null;
  const upb = Number(input.unitsPerBox ?? 0);
  if (upb > 1) return null;
  return (
    `boxes/pieces given (boxes:${input.boxes ?? 0}, pieces:${input.pieces ?? 0}) but no pack ` +
    `resolves (unitsPerBox:${input.unitsPerBox ?? "none"}) — the split has no denominator, so it ` +
    `cannot be priced and would be silently dropped`
  );
}

export function lineAmbiguity(input: {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}): string | null {
  const { qty, boxes, pieces, unitsPerBox } = input;
  // FIRST (SA-077e). Be precise about what that ordering does and does not buy, because a future
  // reader reordering these checks needs to know whether it is load-bearing for CORRECTNESS.
  //
  // It is NOT. A VALID split is never at risk of wrongful refusal whatever the order: it has a
  // pack above 1, and `splitWithoutPack` only fires at a pack of 1 or less. Those preconditions
  // are mutually exclusive.
  //
  // What the ordering decides is the MESSAGE on an input that trips two checks at once, and there
  // is exactly one such input. The boxes/pieces integer loop below is the only check here that is
  // NOT gated on `hasBoxPackaging`, so a split with no pack AND a non-integer box or piece count
  // fires both. First position makes that report "no pack resolves" rather than "boxes must be an
  // integer" — a precedence choice, not a safety one. Every other check requires unitsPerBox > 1
  // and therefore cannot co-fire at all.
  //
  // The hole this closes is separate from the ordering: before it, a split with no pack passed
  // every check below, all of which are pack-gated, and was reported as unambiguous.
  const noPack = splitWithoutPack({ boxes, pieces, unitsPerBox });
  if (noPack != null) return noPack;
  const upb = Number(unitsPerBox ?? 0);
  const hasBoxPackaging = upb > 1;
  const boxesGiven = boxes != null;
  const piecesGiven = pieces != null;

  for (const [name, v] of [
    ["boxes", boxes],
    ["pieces", pieces],
  ] as const) {
    if (v != null && !Number.isInteger(Number(v))) return `${name} must be an integer, got ${v}`;
  }
  if (hasBoxPackaging && qty != null && !Number.isInteger(Number(qty))) {
    return `qty must be an integer, got ${qty}`;
  }

  if (hasBoxPackaging && !boxesGiven && !piecesGiven) {
    return "unitsPerBox > 1 with neither boxes nor pieces given — qty alone is ambiguous (per-box vs per-piece); the B644 shape";
  }
  if (hasBoxPackaging && piecesGiven && Number(pieces) >= upb) {
    return `pieces (${pieces}) >= unitsPerBox (${upb}) — roll over via normalizeBoxesPieces first`;
  }
  if (hasBoxPackaging && (boxesGiven || piecesGiven)) {
    const implied = Number(boxes ?? 0) * upb + Number(pieces ?? 0);
    if (Number(qty) !== implied) {
      return `qty (${qty}) disagrees with boxes*unitsPerBox+pieces (${implied})`;
    }
    // R-ui PC-probe follow-up, 2026-09-21: boxes:0, pieces:0 passed every check above (both
    // given, so "neither given" doesn't fire; disagreement agrees with itself at 0) and minted
    // a $0 line — buildLine's N1 already refuses this at the choke point, but a direct caller of
    // computeLineSubtotalStrict (skipping buildLine) got no such refusal. Now they agree.
    if (!(implied > 0)) {
      return `qty must be > 0, got boxes:${boxes} pieces:${pieces} (${implied} total)`;
    }
  }
  return null;
}

/**
 * `computeLineSubtotal`'s strict sibling for NEW writes (owner ruling 2026-09-21, the "refuse
 * ambiguity" design on #938 — the B644 family). `computeLineSubtotal` is deliberately lenient: a
 * boxed product (`unitsPerBox > 1`) with neither `boxes` nor `pieces` given falls through to the
 * non-boxed branch and silently prices `qty x unitPrice` — exactly the B644 shape (a 12x
 * overcharge). This throws {@link AmbiguousLineError} instead of guessing whenever
 * {@link lineAmbiguity} finds a reason (see its doc for the exact list). Never fires when the
 * caller normalizes first (see {@link buildLine}, `./build-line`) and gives a boxed axis a real
 * split — only for a caller who skips that step, or gives an inconsistent one.
 *
 * ERROR CONTRACT: `AmbiguousLineError.code` is `"AMBIGUOUS_LINE"`. A caller that surfaces this
 * through the API must map it to a 4xx, never a 500 — staff see the reason, a buyer a generic
 * line (Senior Architect review, 2026-09-21). No API caller exists yet (PR-1 has none); the
 * NestJS exception filter is wired in the PR that adds the first real caller.
 *
 * `computeLineSubtotal` itself is unchanged and keeps every existing caller (display, PDF,
 * duplicate, legacy rows) lenient forever; this only guards a NEW write that opts in.
 */
export function computeLineSubtotalStrict(input: LineSubtotalInput): number {
  const { unitPrice, qty, boxes, pieces, unitsPerBox, freeUnits = 0 } = input;
  const reason = lineAmbiguity({ qty, boxes, pieces, unitsPerBox });
  if (reason != null) throw new AmbiguousLineError(`computeLineSubtotalStrict: ${reason}`);
  return computeLineSubtotal({ unitPrice, qty, boxes, pieces, unitsPerBox, freeUnits });
}

/**
 * Prorate a line's ALREADY-AGREED subtotal for a partial delivered/billed
 * quantity — e.g. the driver at-door short-pick estimate, or any other "what
 * does `deliveredQty` of `orderQty` cost" question asked outside the invoice
 * itself. Reference oracle: `invoices.service.ts`'s `buildInvoiceItemData`
 * (READ-ONLY here — another lane owns that file), specialised to a single
 * bill from scratch (its `priorBilledQty` is always 0 in this shape).
 *
 * MONEY COMES FROM THE STORED SUBTOTAL, never a live re-price — same rule as
 * the reference oracle, so a partial estimate agrees with what the invoice
 * will actually bill.
 *
 * `freeUnits` (default 0) is the line's BUY_N_GET_M snapshot, counted in whole
 * SELLING units — which on a box-split line means BOXES, while
 * `deliveredQty`/`orderQty` stay in that line's own qty axis (PIECES). The two
 * axes are bridged by `freeUnitSize` (default 1): how many qty units one free
 * unit is worth — the oracle's `freeUnitSize`, i.e. `unitsPerBox` when the line
 * was stored WITH a box/piece split and that box size is known, and 1 otherwise
 * (selling-unit lines, where the axes already coincide). Feeding a boxes-axis
 * `freeUnits` alongside a pieces-axis `orderQty` at the default `freeUnitSize`
 * under-bills a partial by up to one box, so a box-split caller MUST pass it.
 * At `freeUnits = 0` this reduces to the plain linear formula
 * `storedSubtotal * deliveredQty / orderQty` — REG-B50's bug was exactly that
 * linear formula applied unconditionally, even when the line HAD free units.
 *
 * `storedSubtotal` accepts `number | null | undefined` — mobile's contract,
 * kept here to match callers whose stored subtotal type is itself nullable
 * (e.g. `short-pick.ts`'s `ShortPickLine.subtotal` is `number | null`) and
 * passes it straight through; the body already coerces via `Number(x) || 0`.
 *
 * The general case is the reference oracle's PAID-BASIS floored cumulative
 * telescope: a free unit is a whole unit while a subtotal prorated over the
 * raw delivered quantity would disagree with the floored free-unit
 * allocation by up to one unit price on a partial, so this prorates over the
 * PAID quantity instead (`orderQty - freeUnits * freeUnitSize`). That keeps the
 * stored subtotal equal to `computeLineSubtotal(..., freeUnits)` and makes a
 * full delivery (`deliveredQty === orderQty`) copy it back verbatim.
 *
 * `priorBilledQty` (default 0) is the qty earlier partial invoices of this line already billed — pass
 * the order line's `invoicedQty` to preview the NEXT partial exactly as the server bills it.
 */
export function prorateLineSubtotal(
  storedSubtotal: number | null | undefined,
  deliveredQty: number,
  orderQty: number,
  freeUnits = 0,
  freeUnitSize = 1,
  priorBilledQty = 0,
): number {
  const stored = Number(storedSubtotal) || 0;
  const order = Number(orderQty) || 0;
  if (!(order > 0)) return 0;
  const delivered = Math.max(0, Number(deliveredQty) || 0);
  const free = Math.max(0, Math.trunc(Number(freeUnits) || 0));
  // Qty units per whole free unit; anything non-positive means "same axis".
  const rawSize = Math.trunc(Number(freeUnitSize) || 0);
  const size = rawSize > 0 ? rawSize : 1;

  const paidQty = order - free * size;
  const onPaidBasis = free > 0 && paidQty > 0;
  const basisQty = onPaidBasis ? paidQty : order;

  // Free units consumed by the first `cumQty` units delivered, floored so a
  // partial never claims a fraction of a whole free unit early — mirrors the
  // oracle's `freeUnitsThrough`.
  const freeUnitsThrough = (cumQty: number) =>
    Math.min(free, Math.floor((free * Math.max(0, cumQty)) / order));
  // The PAID share of `cumQty` units delivered — the basis the telescope
  // prorates over — mirrors the oracle's `billedThrough`.
  const billedThrough = (cumQty: number) =>
    onPaidBasis ? cumQty - freeUnitsThrough(cumQty) * size : cumQty;

  // CAP at basisQty: with size > 1 the floored free-unit allocation lands only
  // near 100% delivered, so an uncapped billed share can exceed the paid basis
  // and a PARTIAL delivery would bill MORE than the whole line's agreed
  // subtotal (worked case: 2 boxes + 2 loose of a 4-pack @ $10/box, BUY_1_GET_1,
  // stored $15 — delivered 9 of 10 billed $22.50 uncapped, 1.5x the agreed
  // price). Unreachable at size 1, opened by the freeUnitSize axis; the cap
  // makes every partial bill at most the stored subtotal, and a full delivery
  // still copies it back verbatim.
  // `priorBilledQty` (default 0): the qty earlier partial bills already took. The bill is then the
  // TELESCOPE `cum(prior + delivered) - cum(prior)` with `cum(c) = roundMoney(S x paid(c) / basis)`,
  // exactly the server's `buildInvoiceItemData` — successive partials sum to S to the cent (one bill
  // can be a cent off a from-scratch proration). At prior 0, `cum(0)` is 0 and this is the line above.
  const cumulative = (cumQty: number) =>
    roundMoney((stored * Math.min(billedThrough(cumQty), basisQty)) / basisQty);
  const prior = Math.max(0, Number(priorBilledQty) || 0);
  return roundMoney(cumulative(prior + delivered) - (prior > 0 ? cumulative(prior) : 0));
}

/**
 * B894 (SA-576) / SA-581: THE linear cumulative basis, `creditedThrough(S, c, P) = roundMoney(S × min(c, P) / P)`,
 * shared by `prorateComponentCredit` (#2717) and the return-credit / price-correction callers. What does a SLICE
 * of an already-billed line cost — a return credit, or the target for the qty still held after a partial
 * return? LINEAR.
 *
 * Use this — never {@link prorateLineSubtotal} — wherever a slice is priced FROM SCRATCH. That function is
 * the invoice's delivered-basis bill: its floored free-unit telescope must agree with the invoice line the
 * document shows, and it is non-monotone point by point (a free unit is a whole box on a pieces axis), so
 * it is only right where the curve is telescoped (sum = S). Priced per slice it is NOT additive: BOGO,
 * P=2, F=1, S: returning 1 piece credits S, returning the other credits S again (2S on an S line).
 *
 * Additive (any chunking sums to S up to half a cent per chunk; capped at S), monotone, never negative, and
 * equal to `prorateLineSubtotal(S, c, P)` when there are no free units. `storedSubtotal` accepts null /
 * undefined like its sibling. A non-positive or non-finite `lineQty`, or a non-positive slice, is 0.
 */
export function creditedThrough(
  storedSubtotal: number | null | undefined,
  sliceQty: number,
  lineQty: number,
): number {
  const stored = Number(storedSubtotal) || 0;
  const line = Number(lineQty) || 0;
  const slice = Number(sliceQty) || 0;
  if (!(line > 0) || !(slice > 0)) return 0;
  return roundMoney((stored * Math.min(slice, line)) / line);
}

/**
 * DISPLAY-ONLY derived per-unit price for a case-packed product: case price ÷ units-per-case,
 * rounded to cents. Returns null when the product is sold as single units (unitsPerBox
 * null/0/1) or the input is not a finite number.
 *
 * NEVER persist this, never submit it, never feed it back into line math. Lines always carry
 * the CASE price plus boxes/pieces and are priced by computeLineSubtotal, whose proration is
 * computed before rounding — so `perUnitPrice(p, upb) * pieces` can differ from the true line
 * subtotal by a cent. computeLineSubtotal is authoritative; this is a shopper-facing hint.
 */
export function perUnitPrice(unitPrice: number, unitsPerBox?: number | null): number | null {
  const upb = Number(unitsPerBox ?? 0);
  const price = Number(unitPrice);
  if (!(upb > 1) || !Number.isFinite(price)) return null;
  return roundMoney(price / upb);
}

// ─── Margin: the "negotiation floor" (pos-cost-roles-spec §1) ─────────────────
// `unitCost` (Product.averageCost) is per PIECE. `unitPrice` is per SELLING UNIT
// (a BOX when unitsPerBox > 1, else a piece). Bring cost onto the selling-unit
// basis before comparing, or margins are wrong by a factor of unitsPerBox — the
// same class of bug the box-proration fix guards.

/** Cost of one selling unit: piece cost × unitsPerBox for boxed products, else the piece cost. */
export function costPerSellingUnit(unitCost: number, unitsPerBox?: number | null): number {
  const upb = Number(unitsPerBox ?? 0);
  return upb > 1 ? Number(unitCost) * upb : Number(unitCost);
}

/** Gross margin fraction on a line: (price − cost) / price. null when price ≤ 0 or cost unknown. */
export function computeMarginFraction(
  unitPrice: number,
  unitCost: number | null | undefined,
  unitsPerBox?: number | null,
): number | null {
  if (unitCost == null || !Number.isFinite(Number(unitCost))) return null;
  const price = Number(unitPrice);
  if (!(price > 0)) return null;
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  return (price - cost) / price;
}

/** The selling-unit price that yields exactly `floor` margin for the given piece cost. */
export function priceForMarginFloor(
  unitCost: number,
  floor: number,
  unitsPerBox?: number | null,
): number {
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  const f = Math.min(Math.max(Number(floor) || 0, 0), 0.99); // margin must stay < 1
  return roundMoney(cost / (1 - f));
}

export type MarginClass = "ok" | "warn" | "belowFloor" | "belowCost";

/**
 * Classify a margin fraction against a floor:
 * `belowCost` (< 0) · `belowFloor` (< floor) · `warn` (within 5 points above floor) · `ok`.
 * Returns null when margin is unknown (no cost).
 */
export function classifyMargin(margin: number | null, floor: number): MarginClass | null {
  if (margin == null) return null;
  if (margin < 0) return "belowCost";
  if (margin < floor) return "belowFloor";
  if (margin < floor + 0.05) return "warn";
  return "ok";
}

// ─── Category tax (regulated items, Phase 4 W3) ───────────────────────────────
// A per-category levy that is a SEPARATE dimension from boxed-line price
// proration: per-unit taxes apply to the PIECE count (never the boxed subtotal),
// so they compose with computeLineSubtotal without re-introducing the unitsPerBox
// over-charge.

export type CategoryTaxType =
  "EXCISE_PER_UNIT" | "PERCENT_OF_SALE" | "PER_VOLUME" | "DEPOSIT_PER_CONTAINER" | "NONE";

export interface CategoryTaxInput {
  taxType: CategoryTaxType;
  /** PERCENT_OF_SALE → a fraction (0.05 = 5%); otherwise $ per unit of `unitBasis`. */
  rate: number;
  /** True when the tax is already baked into the price (shown "incl.", not added on top). */
  priceIncludesTax?: boolean;
  /**
   * Quantity expressed in the category's `unitBasis` — the multiplicand for
   * per-unit taxes. The CALLER converts to the basis: EXCISE_PER_UNIT and
   * DEPOSIT_PER_CONTAINER pass the piece count (1 piece = 1 pack/container);
   * PER_VOLUME passes the true volume (pieces × volume-per-piece, e.g. ounces).
   * May be fractional (volume) and may be negative (a return/reversal line — the
   * tax then reverses in sign). Unused by PERCENT_OF_SALE.
   */
  unitBasisQty: number;
  /** The line's net sale (computeLineSubtotal result) — only used by PERCENT_OF_SALE. */
  lineSubtotal: number;
}

/**
 * Compute the category (regulated) tax for one line, rounded to cents. Input
 * signs are preserved, so a return/reversal line (negative qty or subtotal)
 * yields a negative tax.
 *
 * - PERCENT_OF_SALE: `rate` × subtotal. When `priceIncludesTax`, the subtotal
 *   already contains the tax, so the embedded portion is `subtotal × rate/(1+rate)`.
 * - EXCISE_PER_UNIT / PER_VOLUME / DEPOSIT_PER_CONTAINER: `rate` × `unitBasisQty`.
 *   A per-unit levy on the quantity-in-basis, orthogonal to how price is prorated
 *   across boxes — never derive it from the boxed subtotal.
 * - NONE (or `rate` ≤ 0): 0.
 */
export function computeCategoryTax(input: CategoryTaxInput): number {
  const rate = Number(input.rate) || 0;
  if (rate <= 0) return 0;
  const basisQty = Number(input.unitBasisQty) || 0;
  const subtotal = Number(input.lineSubtotal) || 0;
  switch (input.taxType) {
    case "PERCENT_OF_SALE":
      return input.priceIncludesTax
        ? roundMoney((subtotal * rate) / (1 + rate))
        : roundMoney(subtotal * rate);
    case "EXCISE_PER_UNIT":
    case "PER_VOLUME":
    case "DEPOSIT_PER_CONTAINER":
      return roundMoney(rate * basisQty);
    case "NONE":
    default:
      return 0;
  }
}

/** The trio B297 (SA-088) freezes on a line at sale time — see the `categoryTaxType` /
 *  `categoryTaxRate` / `categoryPriceIncludesTax` columns on OrderItem/InvoiceItem. */
export interface CategoryTaxSnapshot {
  categoryTaxType: CategoryTaxType | null;
  categoryTaxRate: number | null;
  categoryPriceIncludesTax: boolean | null;
}

/**
 * What a sale writer needs from a live `TrackedCategory` row to stamp the trio — never the
 * full Prisma model, just the fields `categoryTaxSnapshotOf`/`computeCategoryTax` actually
 * read. A `loadCategoryMapForProducts`-shaped loader's `Map<string, TrackedCategoryRow>` is
 * the ONE place callers should type this against, instead of each hand-rolling its own `any`.
 *
 * `rate` accepts a Decimal-shaped value (this package stays framework-agnostic — never
 * `@prisma/client`'s own `Decimal` type — but the real `TrackedCategory.rate` column IS one;
 * a bare `number | string` here was never actually checked against it, since every real caller
 * passes an untyped `tx`). `priceIncludesTax` is non-optional: `TrackedCategory`'s own column
 * is `NOT NULL` — unlike the snapshot trio this function PRODUCES (all three nullable on
 * OrderItem/InvoiceItem, for a non-regulated line), the LIVE category row always has a real
 * boolean here.
 */
export interface TrackedCategoryRow {
  taxType: CategoryTaxType;
  rate: number | string | { toNumber(): number };
  priceIncludesTax: boolean;
}

/**
 * The ONE place a sale writer turns "the category this line belongs to" into the three
 * columns it stamps onto the line. `null`/`undefined` (a non-regulated line — no
 * trackedCategoryId) yields an all-null snapshot; any tracked category — even one whose
 * `taxType` is NONE — yields a full trio, because the line WAS priced under that category's
 * rules (zero tax is still a recorded basis, not "no snapshot"). Never hand-type these three
 * fields at a call site — that's how one of them drifts from the other two (B297-SPEC.md D1).
 */
export function categoryTaxSnapshotOf(
  category: TrackedCategoryRow | null | undefined,
): CategoryTaxSnapshot {
  if (!category) {
    return { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null };
  }
  return {
    categoryTaxType: category.taxType,
    categoryTaxRate: Number(category.rate),
    categoryPriceIncludesTax: !!category.priceIncludesTax,
  };
}

/**
 * COPIES a line's own already-stamped trio verbatim (a merge/consolidation folding a losing
 * line into a winner, or an invoice line duplicated from another) — never re-derives it from any
 * category, live or otherwise. A merge is not a new sale (SA-098a): the line's own snapshot is
 * the fact. `null`/`undefined` copies through as an all-null snapshot (nothing to copy).
 */
export function copyCategoryTaxSnapshot(
  src:
    | {
        categoryTaxType: CategoryTaxType | null;
        categoryTaxRate: number | string | null;
        categoryPriceIncludesTax: boolean | null;
      }
    | null
    | undefined,
): CategoryTaxSnapshot {
  if (!src) {
    return { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null };
  }
  return {
    categoryTaxType: src.categoryTaxType,
    categoryTaxRate: src.categoryTaxRate == null ? null : Number(src.categoryTaxRate),
    categoryPriceIncludesTax: src.categoryPriceIncludesTax,
  };
}

// ─── Promotions (P5-04, + BUY_N_GET_M) ────────────────────────────────────────
// A promotion adjusts the per-SELLING-UNIT price of a matching line. It composes
// with computeLineSubtotal exactly like any other unitPrice: resolve the NET
// selling-unit price here, then feed it (with boxes/pieces/unitsPerBox) through
// computeLineSubtotal so boxed lines are prorated. NEVER multiply a per-piece
// discount by the piece count — that re-introduces the unitsPerBox over-charge.
//
// Discount convention (mirrors the operator override): a promoted line stores the
// NET unitPrice + the pre-promo price as originalPrice (strikethrough); the saving
// is (originalPrice − unitPrice), never a separate discount amount (no double-count).
//
// BUY_N_GET_M ("buy N get M free") is a DIFFERENT mechanic: it never touches the
// per-unit price. It carries unitPrice = base, originalPrice = null, and a
// freeUnits count of whole SELLING units (boxes for a boxed line — loose pieces
// NEVER count) made free; the caller feeds freeUnits straight into
// computeLineSubtotal, which subtracts whole units before pricing. This keeps the
// saving EXACT — never a rounded net-unit-price (e.g. $35 × 5/6 = $29.1667 would
// drift cents when multiplied back).

export type PromotionType = "PERCENT" | "FIXED" | "QTY_BREAK" | "BUY_N_GET_M";
export type PromotionScope = "ALL" | "CATEGORY" | "PRODUCTS";

/** A promotion's typed rule — already tenant- and window-filtered by the caller. */
export interface PromotionRule {
  id: string;
  type: PromotionType;
  /**
   * PERCENT / QTY_BREAK: percent off (0–100). FIXED: $ off per SELLING UNIT (the
   * box price when boxed). BUY_N_GET_M: free quantity M — an integer ≥ 1.
   */
  value: number;
  /**
   * QTY_BREAK threshold in PIECES; the break applies only when qtyPieces ≥ minQty.
   * BUY_N_GET_M: buy quantity N — an integer ≥ 1, in whole SELLING units. Every
   * (N + M) whole selling units of the same product on a line makes M free (field
   * reuse: no dedicated Promotion columns for N/M).
   */
  minQty?: number | null;
  scope: PromotionScope;
  /** scope=CATEGORY: matched (exact string) against the product's category. */
  category?: string | null;
  /** scope=PRODUCTS: the product ids the promo is scoped to. */
  productIds?: string[] | null;
}

/** The line facts a promo needs to decide applicability + the qty-break gate. */
export interface PromoContext {
  productId: string;
  category?: string | null;
  /** Total line quantity in PIECES (post-normalizeBoxesPieces) — for the QTY_BREAK gate. */
  qtyPieces: number;
  /**
   * Total line quantity in whole SELLING units — boxes for a boxed line (mixed
   * lines count ONLY full boxes; loose pieces NEVER count), qty for a piece
   * line. Drives BUY_N_GET_M's free-unit math and the savings comparison in
   * `applyBestPromotion`. Callers use the would-be-added quantity (1 unit) when
   * pricing outside a cart, mirroring how `qtyPieces` is sourced today.
   */
  qtyUnits: number;
  /**
   * REG-B109: the line's full box/piece denomination, so `applyBestPromotion`
   * can compare candidates by the money `computeLineSubtotal` would ACTUALLY
   * bill on the FULL entered quantity — a whole-box-only comparison
   * (`qtyUnits` alone) silently drops a mixed line's loose pieces from the
   * comparison even though billing counts them. All three OPTIONAL and
   * additive so the signature stays source-compatible (R7) — but every
   * line-pricing call site DOES pass them, and omitting them is the genuine
   * no-split case (a single would-be-added unit, or a candidate list that is
   * all BUY_N_GET_M on one axis), not a way to keep the old basis: the
   * comparison then degrades to `qtyUnits` alone, which is exact whenever the
   * line has no loose pieces. Same shape as `computeLineSubtotal`'s own
   * `boxes`/`pieces`/`unitsPerBox` — pass the line's stored (or
   * about-to-be-stored) split straight through.
   */
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

export interface PromoResult {
  /** Net (post-promo) selling-unit price. Equals the base when no promo applied. */
  unitPrice: number;
  /** Pre-promo base price for the strikethrough — null when no promo applied. */
  originalPrice: number | null;
  /** The winning promotion id, or null when none applied. */
  appliedPromoId: string | null;
  /**
   * Whole selling units made free by a BUY_N_GET_M promo. 0 for every other
   * type and when no promo applied — feed straight into `computeLineSubtotal`'s
   * `freeUnits` param; NEVER re-derive a discounted unit price for this type.
   */
  freeUnits: number;
}

/** Does a promotion's scope cover this product? */
export function promotionMatchesProduct(promo: PromotionRule, ctx: PromoContext): boolean {
  switch (promo.scope) {
    case "ALL":
      return true;
    case "CATEGORY":
      return !!promo.category && !!ctx.category && promo.category === ctx.category;
    case "PRODUCTS":
      return (promo.productIds ?? []).includes(ctx.productId);
    default:
      return false;
  }
}

/**
 * Net selling-unit price for ONE promo, or null if it doesn't apply to this line
 * (wrong scope, qty-break threshold not met) or doesn't actually lower the price.
 * `basePrice` is the customer's pre-promo selling-unit price (their tier price).
 * Rounded to cents; a promo may never raise the price and never go below 0.
 * BUY_N_GET_M never has a net price — see `promoBogoFreeUnits` below.
 */
function promoNetPrice(basePrice: number, promo: PromotionRule, ctx: PromoContext): number | null {
  if (!promotionMatchesProduct(promo, ctx)) return null;
  const value = Number(promo.value) || 0;
  if (value <= 0) return null;
  let net: number;
  switch (promo.type) {
    case "PERCENT":
      net = basePrice * (1 - Math.min(value, 100) / 100);
      break;
    case "QTY_BREAK": {
      const threshold = Number(promo.minQty ?? 0);
      if (!(threshold > 0) || ctx.qtyPieces < threshold) return null; // gated on the PIECE count
      net = basePrice * (1 - Math.min(value, 100) / 100);
      break;
    }
    case "FIXED":
      net = basePrice - value; // $ off per selling unit (never per piece — see header)
      break;
    default:
      return null; // BUY_N_GET_M (and anything unrecognized) has no net-price form
  }
  net = roundMoney(Math.max(0, net));
  return net < basePrice ? net : null; // only apply when it genuinely lowers the price
}

/**
 * Free-units count for a BUY_N_GET_M ("buy N get M free") promo, or null if it
 * doesn't apply — wrong type/scope, a non-integer or `< 1` N or M (ignored, never
 * a crash), or fewer than one full (N + M) block of whole selling units on the
 * line yet. `minQty` stores N (buy qty), `value` stores M (free qty).
 * PIECES NEVER COUNT: `ctx.qtyUnits` must already be whole selling units only
 * (the caller's job — boxes for a boxed line, pieces for a piece line).
 * `freeUnits = floor(qtyUnits / (N + M)) * M` — the owner's exact table for
 * N=5, M=1: 5 units → 0 free, 6 → 1, 11 → 1, 12 → 2, 18 → 3.
 */
function promoBogoFreeUnits(promo: PromotionRule, ctx: PromoContext): number | null {
  if (promo.type !== "BUY_N_GET_M") return null;
  if (!promotionMatchesProduct(promo, ctx)) return null;
  const n = Number(promo.minQty);
  const m = Number(promo.value);
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(m) || m < 1) return null;
  const qtyUnits = Number(ctx.qtyUnits) || 0;
  const freeUnits = Math.floor(qtyUnits / (n + m)) * m;
  return freeUnits > 0 ? freeUnits : null;
}

/**
 * Apply the best (largest-saving) applicable promotion to a base selling-unit
 * price. Single, non-stacking: the promo that leaves the line billing the
 * LEAST wins — computed via the SAME `computeLineSubtotal` path billing
 * itself uses, on the FULL entered quantity (REG-B109: a whole-box-only
 * comparison silently drops a mixed line's loose pieces even though billing
 * counts them); equal billed totals fall back to the LOWEST net unit price
 * and then to promo id (determinism, as today) — so a line with no whole
 * selling units yet, where every price promo saves $0, still picks the
 * deepest discount exactly as it did before. BUY_N_GET_M never has a net
 * price — its "candidate" for the comparison IS the base, billed with its
 * `freeUnits` subtracted, and it returns `unitPrice = base` unchanged; the
 * free units reduce the SUBTOTAL via `computeLineSubtotal`'s `freeUnits`
 * param, never a rounded net unit price (see the header). `ctx.boxes` /
 * `pieces` / `unitsPerBox` stay optional for signature compatibility (R7), but
 * every line-pricing call site supplies them; without them the comparison
 * falls back to `qtyUnits` (whole selling units only), which is the exact
 * answer for a line with no loose pieces. Returns the base
 * unchanged, `freeUnits: 0`, when none apply.
 */
export function applyBestPromotion(
  basePrice: number,
  promos: PromotionRule[],
  ctx: PromoContext,
): PromoResult {
  const base = roundMoney(basePrice);
  const qtyUnits = Number(ctx.qtyUnits) || 0;
  // REG-B109: price each candidate the way billing actually will
  // (computeLineSubtotal on the FULL entered quantity) so a mixed line's loose
  // pieces count in the comparison instead of being silently dropped. Every
  // line-pricing call site passes the same split it then bills with; a caller
  // with no split to give falls back to the whole-selling-unit basis, which
  // agrees with billing to the cent whenever there are no loose pieces.
  const hasFullQty = ctx.boxes != null || ctx.pieces != null;
  const billFull = (unitPrice: number, freeUnits: number): number =>
    hasFullQty
      ? computeLineSubtotal({
          unitPrice,
          qty: ctx.qtyPieces,
          boxes: ctx.boxes,
          pieces: ctx.pieces,
          unitsPerBox: ctx.unitsPerBox,
          freeUnits,
        })
      : roundMoney(unitPrice * Math.max(0, qtyUnits - freeUnits));

  let bestBilled: number | null = null;
  let bestId: string | null = null;
  let bestNet = base;
  let bestFreeUnits = 0;
  for (const promo of promos) {
    let billed: number;
    let net = base;
    let freeUnits = 0;
    if (promo.type === "BUY_N_GET_M") {
      const free = promoBogoFreeUnits(promo, ctx);
      if (free == null) continue;
      freeUnits = free;
      billed = billFull(base, freeUnits);
    } else {
      const promoNet = promoNetPrice(base, promo, ctx);
      if (promoNet == null) continue;
      net = promoNet;
      billed = billFull(net, 0);
    }
    if (
      bestBilled == null ||
      billed < bestBilled ||
      (billed === bestBilled &&
        (net < bestNet || (net === bestNet && bestId != null && promo.id < bestId)))
    ) {
      bestBilled = billed;
      bestId = promo.id;
      bestNet = net;
      bestFreeUnits = freeUnits;
    }
  }
  if (bestBilled == null || bestId == null) {
    return { unitPrice: base, originalPrice: null, appliedPromoId: null, freeUnits: 0 };
  }
  if (bestFreeUnits > 0) {
    return {
      unitPrice: base,
      originalPrice: null,
      appliedPromoId: bestId,
      freeUnits: bestFreeUnits,
    };
  }
  return { unitPrice: bestNet, originalPrice: base, appliedPromoId: bestId, freeUnits: 0 };
}

// ─── Zero-price guard: a rule that clamps in-scope products to $0.00 ──────────
// promoNetPrice floors the net at 0, so a FIXED "$35 off" rule prices EVERY
// in-scope product at or below $35 at exactly $0.00 — in the buyer catalog AND
// on the invoice the order bills. The rule is legal; the operator just cannot
// see its blast radius while typing it (2026-08-20: one ALL-scoped $35-off promo
// put 699 of a tenant's 1,767 products on the portal at $0.00 with a -100% chip).
// These pure helpers compute that blast radius from the catalog so the promotion
// editor can warn and the API can refuse the write unless it is confirmed.

/** How many product names a scan carries back for the operator-facing warning. */
export const ZERO_PRICE_EXAMPLE_LIMIT = 5;

/** The catalog facts the zero-price scan needs — a product row from any surface. */
export interface PromoScopeProduct {
  id: string;
  name?: string | null;
  category?: string | null;
  /** Canonical SELLING-UNIT price (`Product.pricePerUnit` — the BOX price when boxed). */
  price: number | string | null | undefined;
}

export interface ZeroPriceImpact {
  /** In-scope products the rule would clamp to $0.00. */
  count: number;
  /** How many products the rule's scope covers at all — the denominator. */
  inScope: number;
  /** Up to {@link ZERO_PRICE_EXAMPLE_LIMIT} names of the clamped products. */
  examples: string[];
}

/**
 * Cheap shape check: can this rule zero ANY price at all? A FIXED amount always
 * can (some product is always cheap enough); PERCENT/QTY_BREAK only at a full
 * 100% off. Callers use it to skip the catalog scan for ordinary rules.
 *
 * Only the mechanics with a NET-PRICE form can reach $0.00, so the switch is
 * explicit rather than a `!== "FIXED"` fallthrough — `value` does not mean
 * "percent" for every type. BUY_N_GET_M stores M (free units) in `value`, and a
 * bare `value >= 100` would send "buy 1 get 100 free" on a pointless full-catalogue
 * scan. It could never be flagged anyway: `promoBogoFreeUnits` requires N >= 1, so
 * `floor(qtyUnits / (N + M)) * M` is strictly less than `qtyUnits` — a free-unit
 * rule can discount a line steeply but can never make one free.
 */
export function ruleCanZeroPrice(promo: Pick<PromotionRule, "type" | "value">): boolean {
  const value = Number(promo.value) || 0;
  if (value <= 0) return false;
  switch (promo.type) {
    case "FIXED":
      return true;
    case "PERCENT":
    case "QTY_BREAK":
      return value >= 100;
    default:
      return false; // no net-price form ⇒ nothing for the scan to find
  }
}

/** The qty a rule is judged at — a QTY_BREAK bites at its own threshold. */
function zeroScanQtyPieces(promo: PromotionRule): number {
  return Math.max(1, Math.trunc(Number(promo.minQty ?? 0)) || 1);
}

/**
 * Would this rule price ONE product at exactly $0.00? A product already priced at
 * $0 is never counted — the promotion is not what makes that one free.
 */
export function promotionZeroesProduct(product: PromoScopeProduct, promo: PromotionRule): boolean {
  const base = roundMoney(Number(product.price) || 0);
  if (!(base > 0)) return false;
  const net = promoNetPrice(base, promo, {
    productId: product.id,
    category: product.category ?? null,
    qtyPieces: zeroScanQtyPieces(promo),
    // One selling unit: the question is what a single unit would ring up at.
    qtyUnits: 1,
  });
  return net === 0;
}

/**
 * Scan a catalog for the products a rule would sell for $0.00. Callers may
 * pre-filter to the rule's scope in SQL; the scope is re-checked here either way,
 * so an unfiltered catalog is equally correct (just more work).
 */
export function scanPromotionZeroPrice(
  products: PromoScopeProduct[],
  promo: PromotionRule,
): ZeroPriceImpact {
  const impact: ZeroPriceImpact = { count: 0, inScope: 0, examples: [] };
  const qtyPieces = zeroScanQtyPieces(promo);
  for (const product of products) {
    const inScope = promotionMatchesProduct(promo, {
      productId: product.id,
      category: product.category ?? null,
      qtyPieces,
      qtyUnits: 1,
    });
    if (!inScope) continue;
    impact.inScope += 1;
    if (!promotionZeroesProduct(product, promo)) continue;
    impact.count += 1;
    if (impact.examples.length < ZERO_PRICE_EXAMPLE_LIMIT) {
      impact.examples.push(product.name || product.id);
    }
  }
  return impact;
}

/** The one operator-facing sentence for a zero-price warning or refusal. */
export function zeroPriceWarning(impact: ZeroPriceImpact): string {
  const noun = impact.count === 1 ? "product" : "products";
  return `This discount is larger than the price of ${impact.count} ${noun} in scope — they would sell for $0.00.`;
}

// ─── Price-override direction: upsell vs discount ─────────────────────────────
// A one-time operator override stores the NET unitPrice + the catalog base as
// originalPrice (the discount convention above). The DIRECTION is derived, not
// stored: an UPSELL sells ABOVE the base, a DISCOUNT below. Scoped to MANUAL so a
// premium tier (SPECIAL, where originalPrice = list < unitPrice = tier) is never
// mistaken for an upsell.

export interface PriceOverrideLine {
  priceType?: string | null;
  unitPrice: number | string;
  originalPrice?: number | string | null;
}

/** True when a line is an operator MANUAL override priced ABOVE the catalog base. */
export function isUpsellLine(line: PriceOverrideLine): boolean {
  if (line.priceType !== "MANUAL" || line.originalPrice == null) return false;
  return Number(line.unitPrice) > Number(line.originalPrice);
}

/** The half-cent band inside which a typed price IS the baseline (no repricing decision). */
export const STAFF_OVERRIDE_TOLERANCE = 0.005;

/**
 * SA-588 — is `a` within ±½¢ ({@link STAFF_OVERRIDE_TOLERANCE}) of `b`? Decided in 4-dp units via
 * the one {@link round4}: both prices and their difference are snapped to 4 dp, so a boundary
 * like 8.005 vs 8 is deterministically IN band (a raw `Math.abs(a - b) <= 0.005` is float noise
 * there). One 4-dp unit beyond the boundary is out of band.
 */
export function withinStaffOverrideTolerance(a: number, b: number): boolean {
  return Math.abs(round4(round4(a) - round4(b))) <= STAFF_OVERRIDE_TOLERANCE;
}

/**
 * SA-558b (3) — THE predicate for "this staff-typed price needs a reason": a special-tier line whose
 * price moves more than ½¢ from the action's baseline, with no reason sent or on file. Each caller
 * passes its own baseline: the customer's TIER price for create / substitute / add-during-edit, the
 * line's STORED price (and `hasReason` = sent-or-stored) for an existing-line edit. The band test is
 * {@link withinStaffOverrideTolerance}.
 */
export function needsOverrideReason(input: {
  overridePrice: number;
  baselinePrice: number;
  isSpecialTier: boolean;
  hasReason: boolean;
}): boolean {
  const { overridePrice, baselinePrice, isSpecialTier, hasReason } = input;
  if (!isSpecialTier || hasReason) return false;
  return !withinStaffOverrideTolerance(overridePrice, baselinePrice);
}

export type StaffOverrideDecision =
  | {
      priceType: "SPECIAL" | "STANDARD" | "DISCOUNTED" | "MANUAL";
      unitPrice: number;
      originalPrice: number | null;
    }
  | { refused: "REASON_REQUIRED" };

/**
 * #2696(c) / SA-558 + SA-558a — the ONE rule for a staff-typed price on an order line, shared by
 * the api and both clients (a client's "needs a reason" check is
 * `decideStaffOverride(...).refused === "REASON_REQUIRED"`; the api owns the 400 text).
 *   - within ½¢ ({@link STAFF_OVERRIDE_TOLERANCE}) of `baselinePrice` (the customer's tier price) is
 *     NOT an override: SPECIAL on a special-tier line (originalPrice = list), STANDARD otherwise
 *     (originalPrice null) — at the clean baseline, never the incoming near-miss float;
 *   - a real change on a special-tier line with no reason ⇒ refused;
 *   - otherwise an override: below list ⇒ DISCOUNTED, at or above list ⇒ MANUAL (an upsell above
 *     list — see {@link isUpsellLine}), originalPrice = list, the price rounded to cents.
 * Pure: the caller resolves the tier and list prices and whether a reason is on file.
 */
export function decideStaffOverride(input: {
  overridePrice: number;
  baselinePrice: number;
  listPrice: number;
  isSpecialTier: boolean;
  hasReason: boolean;
}): StaffOverrideDecision {
  const { overridePrice, baselinePrice, listPrice, isSpecialTier, hasReason } = input;
  if (withinStaffOverrideTolerance(overridePrice, baselinePrice)) {
    return isSpecialTier
      ? { priceType: "SPECIAL", unitPrice: baselinePrice, originalPrice: listPrice }
      : { priceType: "STANDARD", unitPrice: baselinePrice, originalPrice: null };
  }
  if (needsOverrideReason({ overridePrice, baselinePrice, isSpecialTier, hasReason })) {
    return { refused: "REASON_REQUIRED" };
  }
  return {
    priceType: overridePrice < listPrice ? "DISCOUNTED" : "MANUAL",
    unitPrice: roundMoney(overridePrice),
    originalPrice: listPrice,
  };
}

/**
 * A customer's EFFECTIVE buyer price for a product. An operator's remembered
 * upsell — a saved override net price ABOVE the catalog LIST price — is sticky and
 * overrides the tier everywhere the buyer is priced (catalog, cart, checkout). A
 * remembered price at or below list does NOT stick, so a one-time discount never
 * becomes a standing buyer price (and never RAISES a low-tier customer). Returns
 * the tier price when there is no sticky upsell.
 */
export function effectiveBuyerPrice(
  tierPrice: number,
  listPrice: number,
  rememberedPrice: number | null | undefined,
): number {
  const tier = Number(tierPrice) || 0;
  if (rememberedPrice == null) return tier;
  const remembered = Number(rememberedPrice);
  return remembered > Number(listPrice) ? roundMoney(remembered) : tier;
}

// ─── Qty display: boxes + pieces split ────────────────────────────────────────
// A boxed line stores its denomination (boxes/pieces/unitsPerBox snapshots) on
// the order AND invoice line, but read surfaces used to render only the raw
// piece count. One shared formatter so "2 boxes + 3 pcs" reads identically on
// the order detail, invoice detail, and PDF.
//
// DOCUMENT wording stays "boxes + pcs" deliberately (2026-07-30): it is shorter,
// scans better in the narrow PDF qty column, and matches how wholesale paperwork
// normally reads. Operator-facing setup and selling UI speaks the same vocabulary
// (owner ruling R2, 2026-10-07): "Box" is the pack, "pcs" the loose item (Pieces per box,
// Box|Piece toggle); a bigger level uses its configured name.
// `unitLabel` still overrides the loose-unit noun per product.

export interface QtySplitInput {
  /** Total quantity (pieces for boxed lines). Used when no split is stored. */
  qty: number | string;
  /** Stored split — null/undefined ⇒ not a boxed line (render plain qty). */
  boxes?: number | null;
  pieces?: number | null;
  /** Label for loose pieces; defaults to "pcs". */
  unitLabel?: string | null;
  /**
   * Label for the box-level unit (units/PO minimal, 2026-09-19); defaults to
   * "box"/"boxes". A custom label pluralises with "s" unless it already ends
   * in "s". Additive — every existing call (no `boxLabel`) is unchanged.
   */
  boxLabel?: string | null;
}

/** "2 boxes + 3 pcs" | "1 box" | "4 pcs" | plain trimmed qty (non-boxed line). */
export function formatQtySplit({ qty, boxes, pieces, unitLabel, boxLabel }: QtySplitInput): string {
  if (boxes == null && pieces == null) {
    const n = Number(qty);
    if (!Number.isFinite(n)) return String(qty);
    // Integers render bare; fractional qty keeps up to 3 dp (Decimal(10,3)).
    return Number.isInteger(n) ? String(n) : String(parseFloat(n.toFixed(3)));
  }
  const b = Math.max(0, Math.trunc(Number(boxes ?? 0)));
  const p = Math.max(0, Math.trunc(Number(pieces ?? 0)));
  const label = (unitLabel ?? "").trim() || "pcs";
  const boxSingular = (boxLabel ?? "").trim() || "box";
  const boxPlural =
    boxSingular === "box" ? "boxes" : boxSingular.endsWith("s") ? boxSingular : `${boxSingular}s`;
  const parts: string[] = [];
  if (b > 0) parts.push(`${b} ${b === 1 ? boxSingular : boxPlural}`);
  if (p > 0) parts.push(`${p} ${label}`);
  return parts.length > 0 ? parts.join(" + ") : "0";
}

export interface UnitLineQtyInput {
  qty: number | string;
  boxes?: number | null;
  pieces?: number | null;
  /** units_v1 (2026-09-19): the line's own selling unit ("Case") when this line
   *  was sold by a non-pack unit rather than by loose pieces. Empty/whitespace
   *  is the pack (every existing call, no `unitLabel`, is unchanged). */
  unitLabel?: string | null;
}

/**
 * The quantity text of a line that may be sold by its own unit (units_v1) — the ONE
 * formatter for the invoice/order qty cell on web, api (PDF + email) and mobile, so a
 * units_v1 line reads the same everywhere: "3 Cases" (boxed split), never "3 boxes"
 * (B653), and "5 Piece" for a factor-1 unit (no split to attach the label to — web
 * parity, B757 follow-up), never a bare "5". A pack line (no `unitLabel`) is EXACTLY
 * `formatQtySplit` — byte-identical to before this function existed, so a tenant
 * without `flag.units_v1` (which can never hold a unit line) sees no change.
 */
export function invoiceLineQtyText(item: UnitLineQtyInput): string {
  const split = { qty: item.qty, boxes: item.boxes, pieces: item.pieces };
  const label = (item.unitLabel ?? "").trim();
  if (!label) return formatQtySplit(split);
  if (item.boxes == null && item.pieces == null) return `${formatQtySplit(split)} ${label}`;
  return formatQtySplit({ ...split, boxLabel: label });
}

// ─── Purchase-order line pack (#2066 review round) ────────────────────────────
// `linePack` moved here verbatim from
// apps/web/app/(dashboard)/inventory/_components/purchase-orders-shared.ts, which now
// re-exports it. Mobile's PO detail screen had read the boxes+pieces split straight off the
// LIVE product's `unitsPerBox`, skipping this stored-wins rule (the class of bug B707/#1171
// fixed for invoice/order lines): a repack (12 -> 6) silently re-denominated an already-written
// line at the NEW pack. Web and mobile both import it; no-mirrors-linepack.spec.ts fails the
// build on a local copy. (The label itself, `unitsLabel`, is ./units-label.ts.)

/**
 * B699/B722: the pack a PO line is denominated in. The line's OWN stored
 * `packSize` wins; the live catalog pack is only the fallback, for a new line
 * or one that never stored a pack. A line stores the pack it was actually
 * written against — re-splitting it at the live pack on every render silently
 * rewrites an already-agreed line's display the moment the product is repacked
 * or un-boxed, the exact bug this function exists to prevent.
 */
export function linePack(line: { packSize?: number | null }, livePack: number): number {
  const stored = Number(line.packSize ?? 0);
  return stored > 1 ? stored : livePack;
}

// ─── Per-unit cost rounding ───────────────────────────────────────────────────

/**
 * Round a per-unit cost to 4 decimal places — the twin of `COST_DP = 4` in
 * `apps/api/src/inventory/costing.ts` (deliberately NOT `roundMoney` in this
 * same file, which only ever rounds to cents). A per-piece cost derived by
 * dividing a case cost by piecesPerBox needs the extra precision so scanned-line
 * boxes<->pieces conversions (`scan-line-units.ts#toBillLine`) round-trip
 * exactly; `roundMoney` still owns the final 2dp money total. Purely
 * additive — does not alter `roundMoney` or any other existing helper.
 */
export function roundUnitCost(n: number): number {
  return round4(n);
}

/**
 * The ONE 4-decimal rounding body (#2717, SA-574 H1): half away from zero via the same
 * decimal-string path as roundMoney (REG-B122) — EPSILON is <= half a ULP for any |n| above
 * ~2e-4 once scaled by 1e4, so a Math.round(n * 1e4) nudge rounds half-at-the-4th-decimal
 * values DOWN. Non-finite input is 0. `roundUnitCost` delegates here.
 */
export function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Number((Math.abs(n) * 10000).toFixed(4)))) / 10000;
}

// ─── Effective qty ────────────────────────────────────────────────────────────

/**
 * Effective qty in pieces, derived from boxes/pieces when present, otherwise
 * the explicit `qty` field. Mirrors the server-side recomputation in
 * `apps/api/src/orders/orders.service.ts`.
 */
export function effectiveQty(
  line: { qty?: number; boxes?: number | null; pieces?: number | null },
  unitsPerBox?: number | null,
): number {
  if (line.boxes != null || line.pieces != null) {
    const upb = Number(unitsPerBox ?? 0);
    return (line.boxes ?? 0) * upb + (line.pieces ?? 0);
  }
  return line.qty ?? 0;
}

/**
 * B465 / SA-588 — the ONE special-tier rule: a tier other than 1 (list / STANDARD) is the customer's
 * documented contract price for the product, so the line is SPECIAL. A pure module-level function
 * (no `this`) so it works detached from any service instance. api, web and mobile import it; no
 * app carries a local copy (pinned by `no-mirrors-special-tier.spec.ts`).
 */
export const isSpecialTier = (tierForProduct: number): boolean => tierForProduct !== 1;
