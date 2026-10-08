/**
 * Pure planning logic for scripts/backfill-tenant-units.mjs (units U-6). No I/O, no Prisma.
 *
 * Input is ONE tenant's rows (already tenant-scoped by the caller); output is the set of writes the
 * script would make plus COUNTS ONLY. Idempotent by construction: a TenantUnit that already exists
 * for a nameKey is never planned again, only a NULL tenantUnitId / NULL-or-blank packLabel is filled.
 *
 * nameKey = lower(trim(name)) — identical to the TenantUnit service's rule (units U-1).
 */
"use strict";

const MAX_NAME_LENGTH = 30;
/** Piece synonyms: base words, never a TenantUnit (null baseUnitLabel already means "Piece"). */
const PIECE_SYNONYMS = new Set(["piece", "pieces", "each", "unit", "pcs"]);

function nameKeyOf(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase();
}

/**
 * @param {{
 *   productUnits: Array<{ id: string, label: string|null, tenantUnitId: string|null }>,
 *   products: Array<{ id: string, unit: string|null, packLabel: string|null }>,
 *   existingUnits: Array<{ nameKey: string }>,
 * }} input
 */
function planTenantUnits({ productUnits, products, existingUnits }) {
  const existingKeys = new Set(existingUnits.map((u) => u.nameKey));

  // nameKey -> Map(trimmed original casing -> occurrences)
  const casings = new Map();
  const note = (raw) => {
    const name = String(raw ?? "").trim();
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

  const synonymKeys = new Set();
  const tooLongKeys = new Set();
  const usable = new Set();
  for (const key of casings.keys()) {
    if (PIECE_SYNONYMS.has(key)) synonymKeys.add(key);
    else if (key.length > MAX_NAME_LENGTH) tooLongKeys.add(key);
    else usable.add(key);
  }

  const toCreate = [];
  let existing = 0;
  for (const key of [...usable].sort()) {
    if (existingKeys.has(key)) {
      existing += 1;
      continue;
    }
    // Most common original casing; ties break lexicographically so the plan is deterministic.
    const best = [...casings.get(key).entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0][0];
    toCreate.push({ name: best, nameKey: key });
  }

  const links = [];
  for (const pu of productUnits) {
    if (pu.tenantUnitId) continue;
    const key = labelKeyByUnit.get(pu.id);
    if (key && usable.has(key)) links.push({ productUnitId: pu.id, nameKey: key });
  }

  const packFills = [];
  let packTooLong = 0;
  for (const p of products) {
    if (p.packLabel && p.packLabel.trim() !== "") continue;
    const word = String(p.unit ?? "").trim();
    if (!word) continue;
    if (word.length > MAX_NAME_LENGTH) {
      packTooLong += 1;
      continue;
    }
    packFills.push({ productId: p.id, packLabel: word });
  }

  return {
    toCreate,
    links,
    packFills,
    counts: {
      tenantUnitsCreated: toCreate.length,
      tenantUnitsExisting: existing,
      productUnitsLinked: links.length,
      productsPackLabelFilled: packFills.length,
      skippedTooLong: tooLongKeys.size + packTooLong,
      skippedSynonyms: synonymKeys.size,
    },
  };
}

module.exports = { planTenantUnits, nameKeyOf, PIECE_SYNONYMS, MAX_NAME_LENGTH };
