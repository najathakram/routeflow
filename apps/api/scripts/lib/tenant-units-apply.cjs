/**
 * Write side of scripts/backfill-tenant-units.mjs (units U-6). Takes the pure plan from
 * tenant-units-plan.cjs and applies it through a Prisma-like client (`$transaction`, `tenantUnit`,
 * `productUnit`, `product`). The tenant id comes from the caller, never from the plan.
 *
 * Shape of a run:
 *   1. ONE small transaction upserts the planned TenantUnits (idempotent: upsert by nameKey).
 *   2. The ladder links and pack-label fills are grouped by PRODUCT and applied in batches of
 *      BACKFILL_BATCH_SIZE products, each batch in its own transaction, so no transaction grows with
 *      the size of the catalog and a crash loses at most the batch in flight.
 *
 * Resume and idempotence: every write is guarded (a link only where tenantUnitId IS NULL, a fill
 * only where packLabel is NULL/blank) and the caller re-plans from the database on each run, so a
 * re-run after a crash (or after success) plans only what is still missing. A product's link and
 * fill always travel in the same batch, so a crash never leaves a product half-done.
 */
"use strict";

/**
 * Products per transaction. 200 products is at most ~200 pack-label updates plus their ladder links
 * (a few hundred single-row statements): comfortably inside the 60 s transaction timeout below,
 * while keeping row locks and rollback cost small. Not a CLI option (the script has no tuning
 * flags); change it here.
 */
const BACKFILL_BATCH_SIZE = 200;

const TX_OPTIONS = { timeout: 60000, maxWait: 10000 };

/**
 * Group the plan's writes by product, then slice the products into batches of `size`.
 * @param {{ links: Array<{productUnitId: string, nameKey: string}>,
 *           packFills: Array<{productId: string, packLabel: string}> }} plan
 * @param {Map<string, string>} productIdByUnit ProductUnit.id -> Product.id
 * @param {number} size products per batch
 * @returns {Array<{ links: Array<object>, packFills: Array<object> }>}
 */
function batchWrites(plan, productIdByUnit, size = BACKFILL_BATCH_SIZE) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("batch size must be a positive integer");
  }
  const byProduct = new Map();
  const slot = (key) => {
    let s = byProduct.get(key);
    if (!s) byProduct.set(key, (s = { links: [], packFills: [] }));
    return s;
  };
  for (const l of plan.links) {
    // A unit whose product is unknown still gets its own slot rather than being dropped.
    slot(productIdByUnit.get(l.productUnitId) ?? `unit:${l.productUnitId}`).links.push(l);
  }
  for (const f of plan.packFills) slot(f.productId).packFills.push(f);

  const keys = [...byProduct.keys()].sort();
  const batches = [];
  for (let i = 0; i < keys.length; i += size) {
    const batch = { links: [], packFills: [] };
    for (const key of keys.slice(i, i + size)) {
      const s = byProduct.get(key);
      batch.links.push(...s.links);
      batch.packFills.push(...s.packFills);
    }
    batches.push(batch);
  }
  return batches;
}

/**
 * @param {{ prisma: any, tenantId: string,
 *           plan: { toCreate: Array<{name: string, nameKey: string}>, links: Array<object>, packFills: Array<object> },
 *           existingUnits: Array<{ id: string, nameKey: string }>,
 *           productIdByUnit: Map<string, string>,
 *           batchSize?: number,
 *           onBatch?: (done: number, total: number) => void }} args
 * @returns {Promise<{ batches: number, linked: number, filled: number, linksChanged: number, fillsChanged: number }>}
 *   linked/filled are rows ACTUALLY written (summed updateMany counts); linksChanged/fillsChanged
 *   are planned writes that matched 0 rows because the row changed since planning.
 */
async function applyTenantUnitsPlan({
  prisma,
  tenantId,
  plan,
  existingUnits,
  productIdByUnit,
  batchSize = BACKFILL_BATCH_SIZE,
  onBatch,
}) {
  const batches = batchWrites(plan, productIdByUnit, batchSize);
  const idByKey = new Map(existingUnits.map((u) => [u.nameKey, u.id]));

  if (plan.toCreate.length > 0) {
    await prisma.$transaction(async (db) => {
      for (const c of plan.toCreate) {
        const row = await db.tenantUnit.upsert({
          where: { tenantId_nameKey: { tenantId, nameKey: c.nameKey } },
          create: { tenantId, name: c.name, nameKey: c.nameKey },
          update: {},
          select: { id: true },
        });
        idByKey.set(c.nameKey, row.id);
      }
    }, TX_OPTIONS);
  }

  const totals = { linked: 0, filled: 0, linksChanged: 0, fillsChanged: 0 };
  let done = 0;
  for (const batch of batches) {
    // Counted per batch and added to the totals only once the batch has committed.
    const got = { linked: 0, filled: 0, linksChanged: 0, fillsChanged: 0 };
    const count = (res, hit, miss) => {
      if (res.count > 0) got[hit] += res.count;
      else got[miss] += 1;
    };
    await prisma.$transaction(async (db) => {
      for (const l of batch.links) {
        const tenantUnitId = idByKey.get(l.nameKey);
        if (!tenantUnitId) {
          // A link whose unit was neither created nor pre-existing is a planner bug: fail the batch.
          throw new Error("internal: link target missing; rolling back");
        }
        const res = await db.productUnit.updateMany({
          // `label` pins the value the plan was built from: a level renamed since planning updates
          // 0 rows and is counted as changed, never linked on a stale view.
          where: { id: l.productUnitId, tenantId, tenantUnitId: null, label: l.label },
          data: { tenantUnitId },
        });
        count(res, "linked", "linksChanged");
      }
      for (const f of batch.packFills) {
        // Fill only a still-NULL/blank packLabel; never overwrite.
        const res = await db.product.updateMany({
          // `unit` pins the word the plan was built from: a product whose unit changed since
          // planning updates 0 rows and is counted as changed, never filled on a stale view.
          where: {
            id: f.productId,
            tenantId,
            unit: f.unit,
            OR: [{ packLabel: null }, { packLabel: "" }],
          },
          data: { packLabel: f.packLabel },
        });
        count(res, "filled", "fillsChanged");
      }
    }, TX_OPTIONS);
    for (const k of Object.keys(totals)) totals[k] += got[k];
    done += 1;
    if (onBatch) onBatch(done, batches.length);
  }
  return { batches: batches.length, ...totals };
}

module.exports = { applyTenantUnitsPlan, batchWrites, BACKFILL_BATCH_SIZE };
