/**
 * Pure planning logic for scripts/backfill-tenant-units.mjs (units U-6). No I/O, no Prisma.
 *
 * Input is ONE tenant's rows (already tenant-scoped by the caller); output is the set of writes the
 * script would make plus counts (unit NAMES may be printed; never a tenant, slug or row id). The
 * backfill is inserts and FK links only (SA-729:52): TenantUnit rows, ProductUnit.tenantUnitId, and
 * ProductUnit.parentUnitId/perParent (SA-729a item 3). It never writes a Product column. Idempotent
 * by construction: an existing TenantUnit is never planned again, and only NULL fields are filled.
 *
 * nameKey = unitNameKey(name) — NFC, then trim, then case-fold: the TenantUnit service's rule (units
 * U-1). This file is CommonJS and cannot import the TypeScript original, so `unitNameKey` below is a
 * byte-identical port, and tenant-units-parity.spec.ts pins it to `unitNameKey` (packages/pricing).
 * There is no second normaliser in this script.
 *
 * SA-810: the backfill is a SYSTEM writer. It never refuses and never takes a tenant past
 * MAX_ACTIVE_TENANT_UNITS active units. When the names to add exceed the room it adds the most-used
 * names that fit, reports the rest (`overflow`: name + counts) and leaves their levels unlinked.
 */
"use strict";

/**
 * The longest unit name. A copy of `MAX_UNIT_NAME_LENGTH` (units.service.ts) and the DTOs'
 * `@MaxLength(30)`; tenant-units-parity.spec.ts pins them equal.
 */
const MAX_NAME_LENGTH = 30;
/**
 * The most ACTIVE units (archivedAt null) a tenant may have (SA-810). A copy of
 * `MAX_ACTIVE_TENANT_UNITS` in apps/api/src/units/unit-room.ts (U-1); tenant-units-parity.spec.ts pins
 * the two equal.
 */
const MAX_ACTIVE_TENANT_UNITS = 200;
/** The names printed in the overflow report; the rest are a count (never an unbounded wall of text). */
const OVERFLOW_NAMES_PRINTED = 50;
/**
 * Piece synonyms: base words, never a TenantUnit (null baseUnitLabel already means "Piece"). A copy of
 * `PIECE_SYNONYMS` in apps/api/src/units/piece-words.ts; tenant-units-parity.spec.ts pins the two equal.
 */
const PIECE_SYNONYMS = new Set(["piece", "pieces", "each", "unit", "pcs"]);

const isMixedCase = (w) => w !== w.toUpperCase() && w !== w.toLowerCase();

/**
 * Sort order for [casing, count] pairs: most common first; on a tie a mixed-case spelling ("Case")
 * beats ALL-CAPS and all-lowercase (UTF-16 order alone would crown "CASE"); then lexicographic so
 * the plan stays deterministic.
 */
function byCasingPreference(a, b) {
  return (
    b[1] - a[1] ||
    Number(isMixedCase(b[0])) - Number(isMixedCase(a[0])) ||
    (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
}

/** The name a person sees: NFC first (so "Cafe" + U+0301 and "Caf\u00e9" are one word), then trim (NBSP included). */
const cleanName = (name) =>
  String(name ?? "")
    .normalize("NFC")
    .trim();

/**
 * The unit-name comparison key: NFC, then trim, then case-fold. A byte-identical port of
 * `unitNameKey` (packages/pricing, `s.normalize("NFC").trim().toLowerCase()`), pinned to it by
 * tenant-units-parity.spec.ts. Do not change one without the other.
 */
const unitNameKey = (name) =>
  String(name ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase();
const nameKeyOf = unitNameKey;

/** Active units (archivedAt null) a tenant may still add: U-1's `unitRoom`. Negative = over the cap. */
const unitRoomOf = (existingUnits) =>
  MAX_ACTIVE_TENANT_UNITS - existingUnits.filter((u) => !u.archivedAt).length;

/**
 * @param {{
 *   productUnits: Array<{ id: string, productId: string, label: string|null, tenantUnitId: string|null,
 *                         factorToBase: number, parentUnitId: string|null, perParent: number|null }>,
 *   products: Array<{ id: string, unit: string|null }>,   // the legacy pack word only names units
 *   existingUnits: Array<{ nameKey: string, name?: string, archivedAt?: Date|null }>,  // archived included
 * }} input
 */
function planTenantUnits({ productUnits, products, existingUnits }) {
  const existingKeys = new Set(existingUnits.map((u) => u.nameKey));
  const archivedKeys = new Set(existingUnits.filter((u) => u.archivedAt).map((u) => u.nameKey));
  const existingNameByKey = new Map(
    existingUnits.filter((u) => u.name).map((u) => [u.nameKey, u.name]),
  );

  // nameKey -> Map(trimmed original casing -> occurrences)
  const casings = new Map();
  // nameKey -> how many unlinked ladder levels / products' pack words use it (the overflow report)
  const levelsByKey = new Map();
  const productsByKey = new Map();
  const bump = (m, key) => m.set(key, (m.get(key) ?? 0) + 1);
  const note = (raw) => {
    const key = unitNameKey(raw);
    if (!key) return null;
    const name = cleanName(raw);
    let m = casings.get(key);
    if (!m) casings.set(key, (m = new Map()));
    m.set(name, (m.get(name) ?? 0) + 1);
    return key;
  };

  const labelKeyByUnit = new Map();
  for (const pu of productUnits) {
    const key = note(pu.label);
    if (key) {
      labelKeyByUnit.set(pu.id, key);
      if (!pu.tenantUnitId) bump(levelsByKey, key);
    }
  }
  for (const p of products) {
    const key = note(p.unit);
    if (key) bump(productsByKey, key);
  }

  // nameKey -> the most common original casing (see byCasingPreference for the tie rule).
  const bestByKey = new Map();
  for (const [key, m] of casings)
    bestByKey.set(key, [...m.entries()].sort(byCasingPreference)[0][0]);

  const synonymKeys = new Set();
  const tooLongKeys = new Set();
  const usable = new Set();
  for (const key of casings.keys()) {
    // The limit is on the NAME a person sees (the unit's display name), never the case-folded key: a
    // case fold can lengthen a word (U+0130 lowercases to two code units).
    const display = existingNameByKey.get(key) ?? bestByKey.get(key);
    if (PIECE_SYNONYMS.has(key)) synonymKeys.add(key);
    else if (display.length > MAX_NAME_LENGTH) tooLongKeys.add(key);
    else usable.add(key);
  }

  // nameKey -> the tenant's canonical display name: an existing TenantUnit's own name, else the most
  // common original casing.
  const canonicalByKey = new Map();
  const candidates = [];
  let existing = 0;
  for (const key of [...usable].sort()) {
    const best = bestByKey.get(key);
    canonicalByKey.set(key, existingNameByKey.get(key) ?? best);
    if (existingKeys.has(key)) {
      existing += 1;
      continue;
    }
    candidates.push({ name: best, nameKey: key });
  }

  // SA-810: add at most the room the tenant has left (a tenant at or over the cap gets none, and
  // keeps every row it has). `toCreate` is ALWAYS ordered most used first, then by key, so the plan
  // is deterministic and the apply step, which may find less room than this read did, cuts the
  // LEAST used names off its tail. The rest are reported, and their levels stay unlinked.
  const room = Math.max(0, unitRoomOf(existingUnits));
  const uses = (key) => [...casings.get(key).values()].reduce((a, b) => a + b, 0);
  const byUsesThenKey = (a, b) =>
    uses(b.nameKey) - uses(a.nameKey) ||
    (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0);
  const ranked = [...candidates].sort(byUsesThenKey);
  const toCreate = ranked.slice(0, room);
  const overflow = [];
  const overflowKeys = new Set();
  for (const c of ranked.slice(room)) {
    overflowKeys.add(c.nameKey);
    overflow.push({
      name: c.name,
      levels: levelsByKey.get(c.nameKey) ?? 0,
      products: productsByKey.get(c.nameKey) ?? 0,
    });
  }

  const links = [];
  // Archived unit name -> levels linked to it. An archived unit still owns its key (never a second
  // unit), so the link is made, and reported so the operator can restore the unit in Settings.
  const archivedCounts = new Map();
  for (const pu of productUnits) {
    if (pu.tenantUnitId) continue;
    const key = labelKeyByUnit.get(pu.id);
    if (key && usable.has(key) && !overflowKeys.has(key)) {
      if (archivedKeys.has(key)) {
        const name = canonicalByKey.get(key);
        archivedCounts.set(name, (archivedCounts.get(name) ?? 0) + 1);
      }
      // `label` is the raw value the plan was built from: the write guard re-checks it.
      links.push({ productUnitId: pu.id, nameKey: key, label: pu.label });
    }
  }

  const { parentFills, parentSkips, explicitPieceParents } = planParentFills(
    productUnits,
    products,
  );

  return {
    toCreate,
    overflow,
    links,
    parentFills,
    archivedLinks: [...archivedCounts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, levels]) => ({ name, levels })),
    counts: {
      tenantUnitsCreated: toCreate.length,
      tenantUnitsExisting: existing,
      tenantUnitsOverflow: overflow.length,
      productUnitsUnlinkedOverflow: overflow.reduce((n, o) => n + o.levels, 0),
      productUnitsLinked: links.length,
      productUnitsParentFilled: parentFills.length,
      skippedTooLong: tooLongKeys.size,
      skippedSynonyms: synonymKeys.size,
      skippedParent: parentSkips.length,
      explicitPieceParent: explicitPieceParents.length,
    },
    parentSkips,
    explicitPieceParents,
  };
}

/**
 * SA-729a item 3: fill a ladder level's parentUnitId / perParent where they are NULL, from the
 * product's own levels (factorToBase = pieces per one of that level) and its pack.
 *   - the parent is the largest LOWER size of the product that divides this one: a ProductUnit level
 *     (factor > 1), or the PACK (Product.unitsPerBox > 1), which has no row, so it is written as
 *     parentUnitId NULL with perParent = factor / unitsPerBox ("4 Box = 1 Case"); a row at the pack's
 *     own size is that level, so the row wins the tie;
 *   - with neither, the parent is the base: parentUnitId NULL, perParent = the factor. A factor-1 ROW
 *     is never a parent (the base is NULL, SA-728);
 *   - a level that already names a parent but has no perParent gets factor / parent factor;
 *   - perParent must be an integer >= 2, otherwise the level is reported and skipped (never guessed);
 *   - a factor-1 level is the base itself (nothing to fill); a level with perParent set is done.
 * A level that ALREADY names a factor-1 row as its parent is left as it is (fill-only, SA ruling on
 * #3336): only its perParent is filled. Every such level is listed in `explicitPieceParents` (id for the
 * caller, label for the report) so the operator can see them.
 * Every fill carries the values it was planned from (this level's factor and parent, the parent's
 * factor): the apply writes only where they still hold.
 * @returns {{ parentFills: Array<object>, parentSkips: Array<{ productUnitId: string, reason: string }> }}
 */
function planParentFills(productUnits, products = []) {
  const packByProduct = new Map();
  for (const p of products) {
    const upb = Number(p.unitsPerBox);
    if (Number.isInteger(upb) && upb > 1) packByProduct.set(p.id, upb);
  }
  const byProduct = new Map();
  for (const u of productUnits) {
    let list = byProduct.get(u.productId);
    if (!list) byProduct.set(u.productId, (list = []));
    list.push(u);
  }
  const parentFills = [];
  const parentSkips = [];
  const explicitPieceParents = [];
  const skip = (u, reason) => parentSkips.push({ productUnitId: u.id, reason });
  for (const u of productUnits) {
    if (u.parentUnitId != null) {
      const p = (byProduct.get(u.productId) ?? []).find((c) => c.id === u.parentUnitId);
      if (p && p.factorToBase === 1)
        explicitPieceParents.push({ productUnitId: u.id, label: u.label });
    }
    if (u.perParent != null) continue;
    const f = u.factorToBase;
    if (!Number.isInteger(f) || f < 1) {
      skip(u, "factor is not a positive integer");
      continue;
    }
    const siblings = byProduct.get(u.productId) ?? [];
    if (u.parentUnitId == null) {
      if (f === 1) continue; // the base row: no parent, no count
      let parent = null;
      for (const c of siblings) {
        // a factor-1 row is the base, never a parent
        if (c.id === u.id || !Number.isInteger(c.factorToBase) || c.factorToBase <= 1) continue;
        if (c.factorToBase < f && f % c.factorToBase === 0) {
          if (!parent || c.factorToBase > parent.factorToBase) parent = c;
        }
      }
      const upb = packByProduct.get(u.productId);
      const packFits = upb != null && upb < f && f % upb === 0;
      // the pack beats only a SMALLER dividing row (a row at the pack's size is the pack's level)
      const viaPack = packFits && (!parent || upb > parent.factorToBase);
      const parentFactor = viaPack ? upb : parent ? parent.factorToBase : 1;
      parentFills.push({
        productUnitId: u.id,
        productId: u.productId,
        factorToBase: f,
        fromParentUnitId: null,
        parentUnitId: !viaPack && parent ? parent.id : null,
        parentFactor,
        // the pack the fill was planned against (null = no pack, or not chosen): the apply re-reads
        // Product.unitsPerBox and skips the fill if the pack moved
        packFactor: viaPack ? upb : null,
        unitsPerBox: upb ?? null,
        perParent: f / parentFactor,
      });
      continue;
    }
    const parent = siblings.find((c) => c.id === u.parentUnitId);
    if (!parent) {
      skip(u, "its parent is not a level of the same product");
      continue;
    }
    const per = f / parent.factorToBase;
    if (!Number.isInteger(per) || per < 2) {
      skip(u, "its factor is not a whole multiple (>= 2) of its parent's");
      continue;
    }
    parentFills.push({
      productUnitId: u.id,
      productId: u.productId,
      factorToBase: f,
      fromParentUnitId: u.parentUnitId,
      parentUnitId: u.parentUnitId,
      parentFactor: parent.factorToBase,
      packFactor: null,
      perParent: per,
    });
  }
  return { parentFills, parentSkips, explicitPieceParents };
}

/** Counts-only report lines (unit names are fine to print; never tenant names, slugs or ids). */
function archivedLinkLines(archivedLinks) {
  return archivedLinks.map(
    (a) =>
      `linked to archived unit "${a.name}" \u2014 restore in Settings: ${a.levels} product level(s)`,
  );
}

/**
 * The names the cap left out, as report lines: names and counts only (never a tenant, slug or id).
 * @param {Array<{ name: string, levels: number, products: number }>} overflow
 */
function overflowLines(overflow) {
  if (overflow.length === 0) return [];
  const shown = overflow.slice(0, OVERFLOW_NAMES_PRINTED);
  const lines = [
    `not added, the tenant is at the ${MAX_ACTIVE_TENANT_UNITS}-unit cap (SA-810): ` +
      `${overflow.length} unit name(s); their levels stay unlinked and still sell by label`,
    ...shown.map((o) => `  ${o.name}: ${o.levels} level(s), ${o.products} pack word(s)`),
  ];
  if (overflow.length > shown.length)
    lines.push(`  ... and ${overflow.length - shown.length} more`);
  return lines;
}

/**
 * The unit names the apply step left out because the tenant reached the cap after the plan was made
 * (the plan's own `overflow` is reported by `overflowLines`). Names only, bounded like the overflow.
 */
function cappedAtApplyLines(names) {
  if (names.length === 0) return [];
  const shown = names.slice(0, OVERFLOW_NAMES_PRINTED);
  const lines = [
    `left out at apply time, the tenant reached the ${MAX_ACTIVE_TENANT_UNITS}-unit cap since ` +
      `planning (SA-810): ${names.length} unit name(s)`,
    ...shown.map((n) => `  ${n}`),
  ];
  if (names.length > shown.length) lines.push(`  ... and ${names.length - shown.length} more`);
  return lines;
}

module.exports = {
  planTenantUnits,
  cappedAtApplyLines,
  planParentFills,
  unitNameKey,
  nameKeyOf,
  unitRoomOf,
  archivedLinkLines,
  overflowLines,
  PIECE_SYNONYMS,
  MAX_NAME_LENGTH,
  MAX_ACTIVE_TENANT_UNITS,
};
