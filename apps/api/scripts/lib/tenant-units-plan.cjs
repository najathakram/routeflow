/**
 * Pure planning logic for scripts/backfill-tenant-units.mjs (units U-6). No I/O, no Prisma.
 *
 * Input is ONE tenant's rows (already tenant-scoped by the caller); output is the set of writes the
 * script would make plus counts (unit NAMES may be printed; never a tenant, slug or row id). The
 * backfill is inserts and FK links only (SA-729:52): TenantUnit rows, ProductUnit.tenantUnitId, and
 * ProductUnit.parentUnitId/perParent (SA-729a item 3). It never writes a Product column. Idempotent
 * by construction: an existing TenantUnit is never planned again, and only NULL fields are filled.
 *
 * nameKey = lower(trim(name)) — identical to the TenantUnit service's rule (units U-1).
 */
"use strict";

const MAX_NAME_LENGTH = 30;
// Single typed source will be PIECE_SYNONYMS in packages/types (added by the U-1 branch); a parity
// spec pinning this copy follows the merge.
/** Piece synonyms: base words, never a TenantUnit (null baseUnitLabel already means "Piece"). */
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

/** NFC first (so "Cafe" + U+0301 and "Caf\u00e9" are one word), then trim (NBSP included). */
const cleanName = (name) =>
  String(name ?? "")
    .normalize("NFC")
    .trim();

// A copy of the shared unit-name normaliser (`unitNameKey` in packages/types, added by the U-1
// branch); a parity spec pinning the two follows the merge. NFC, then trim, then case-fold.
function nameKeyOf(name) {
  return cleanName(name).toLowerCase();
}

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
  const note = (raw) => {
    const name = cleanName(raw);
    const key = nameKeyOf(name);
    if (!key) return null;
    let m = casings.get(key);
    if (!m) casings.set(key, (m = new Map()));
    m.set(name, (m.get(name) ?? 0) + 1);
    return key;
  };

  const labelKeyByUnit = new Map();
  for (const pu of productUnits) {
    const key = note(pu.label);
    if (key) labelKeyByUnit.set(pu.id, key);
  }
  for (const p of products) note(p.unit);

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

  const toCreate = [];
  // nameKey -> the tenant's canonical display name: an existing TenantUnit's own name, else the most
  // common original casing.
  const canonicalByKey = new Map();
  let existing = 0;
  for (const key of [...usable].sort()) {
    const best = bestByKey.get(key);
    canonicalByKey.set(key, existingNameByKey.get(key) ?? best);
    if (existingKeys.has(key)) {
      existing += 1;
      continue;
    }
    toCreate.push({ name: best, nameKey: key });
  }

  const links = [];
  // Archived unit name -> levels linked to it. An archived unit still owns its key (never a second
  // unit), so the link is made, and reported so the operator can restore the unit in Settings.
  const archivedCounts = new Map();
  for (const pu of productUnits) {
    if (pu.tenantUnitId) continue;
    const key = labelKeyByUnit.get(pu.id);
    if (key && usable.has(key)) {
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
    links,
    parentFills,
    archivedLinks: [...archivedCounts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, levels]) => ({ name, levels })),
    counts: {
      tenantUnitsCreated: toCreate.length,
      tenantUnitsExisting: existing,
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

module.exports = {
  planTenantUnits,
  planParentFills,
  nameKeyOf,
  archivedLinkLines,
  PIECE_SYNONYMS,
  MAX_NAME_LENGTH,
};
