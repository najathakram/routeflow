/**
 * Write side of scripts/backfill-tenant-units.mjs (units U-6). Takes the pure plan from
 * tenant-units-plan.cjs and applies it through a Prisma-like client (`$transaction`,
 * `$executeRawUnsafe`, `$queryRawUnsafe`, `tenantUnit`, `productUnit`). The tenant id comes from the
 * caller, never from the plan. Inserts and FK links only (SA-729:52): no Product column is written.
 *
 * Shape of a run:
 *   1. ONE small transaction upserts the planned TenantUnits (idempotent: upsert by nameKey).
 *   2. The ladder links and parent fills are grouped by PRODUCT and applied in batches of
 *      BACKFILL_BATCH_SIZE products, each batch in its own transaction, so no transaction grows with
 *      the size of the catalog and a crash loses at most the batch in flight.
 * Every transaction sets a lock_timeout and a statement_timeout first.
 *
 * Inside each batch, BEFORE any write (SA M4): the batch's TenantUnits are re-read by nameKey FOR SHARE
 * (a unit deleted since planning is not linked; the share lock keeps it from being renamed or deleted
 * until COMMIT), and every planned parent is re-read FOR SHARE (its factor and product must still be
 * the planned ones).
 *
 * Resume and idempotence: every write is a compare-and-set on the values the plan was built from (a
 * link only where tenantUnitId IS NULL and the label is unchanged; a parent fill only where perParent
 * IS NULL and the factor and parent are unchanged), and the caller re-plans from the database on each
 * run, so a re-run plans only what is still missing. A product's writes always travel in the same
 * batch, so a crash never leaves a product half-done.
 */
"use strict";

/**
 * Products per transaction. 200 products is a few hundred single-row statements: comfortably inside
 * the timeouts below, while keeping row locks and rollback cost small. Not a CLI option (the script
 * has no tuning flags); change it here.
 */
const BACKFILL_BATCH_SIZE = 200;

const TX_OPTIONS = { timeout: 60000, maxWait: 10000 };
/** SET LOCAL inside every write transaction: wait at most 5 s for a row lock, 60 s per statement. */
const WRITE_TIMEOUTS = ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '60s'"];

const UNITS_FOR_SHARE = `SELECT id, "nameKey" FROM "TenantUnit"
  WHERE "tenantId" = $1 AND "nameKey" = ANY($2::text[]) FOR SHARE`;
const PARENTS_FOR_SHARE = `SELECT id, "productId", "factorToBase" FROM "ProductUnit"
  WHERE "tenantId" = $1 AND id = ANY($2::text[]) FOR SHARE`;

/**
 * Group the plan's writes by product, then slice the products into batches of `size`.
 * @param {{ links: Array<{productUnitId: string, nameKey: string}>,
 *           parentFills: Array<{productUnitId: string, productId: string}> }} plan
 * @param {Map<string, string>} productIdByUnit ProductUnit.id -> Product.id
 * @param {number} size products per batch
 * @returns {Array<{ links: Array<object>, parentFills: Array<object> }>}
 */
function batchWrites(plan, productIdByUnit, size = BACKFILL_BATCH_SIZE) {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error("batch size must be a positive integer");
  }
  const byProduct = new Map();
  const slot = (key) => {
    let s = byProduct.get(key);
    if (!s) byProduct.set(key, (s = { links: [], parentFills: [] }));
    return s;
  };
  for (const l of plan.links) {
    // A unit whose product is unknown still gets its own slot rather than being dropped.
    slot(productIdByUnit.get(l.productUnitId) ?? `unit:${l.productUnitId}`).links.push(l);
  }
  for (const f of plan.parentFills ?? []) slot(f.productId).parentFills.push(f);

  const keys = [...byProduct.keys()].sort();
  const batches = [];
  for (let i = 0; i < keys.length; i += size) {
    const batch = { links: [], parentFills: [] };
    for (const key of keys.slice(i, i + size)) {
      const s = byProduct.get(key);
      batch.links.push(...s.links);
      batch.parentFills.push(...s.parentFills);
    }
    batches.push(batch);
  }
  return batches;
}

/** Prisma drops an undefined `where` key (widening an updateMany): refuse one before it can. */
function requireIds(...ids) {
  for (const id of ids) {
    if (typeof id !== "string" || id === "") throw new Error("internal: missing id in a write");
  }
}

/**
 * @param {{ prisma: any, tenantId: string,
 *           plan: { toCreate: Array<{name: string, nameKey: string}>, links: Array<object>,
 *                   parentFills: Array<object> },
 *           productIdByUnit: Map<string, string>,
 *           batchSize?: number,
 *           onBatch?: (done: number, total: number) => void }} args
 * @returns {Promise<{ batches: number, linked: number, parentFilled: number, linksChanged: number,
 *                     parentsChanged: number }>}
 *   linked/parentFilled are rows ACTUALLY written; linksChanged/parentsChanged are planned writes that
 *   were skipped because a row changed since planning (left for a re-run, never overwritten).
 */
async function applyTenantUnitsPlan({
  prisma,
  tenantId,
  plan,
  productIdByUnit,
  batchSize = BACKFILL_BATCH_SIZE,
  onBatch,
}) {
  requireIds(tenantId);
  const batches = batchWrites(plan, productIdByUnit, batchSize);
  const setTimeouts = async (db) => {
    for (const sql of WRITE_TIMEOUTS) await db.$executeRawUnsafe(sql);
  };

  if (plan.toCreate.length > 0) {
    await prisma.$transaction(async (db) => {
      await setTimeouts(db);
      for (const c of plan.toCreate) {
        await db.tenantUnit.upsert({
          where: { tenantId_nameKey: { tenantId, nameKey: c.nameKey } },
          create: { tenantId, name: c.name, nameKey: c.nameKey },
          update: {},
          select: { id: true },
        });
      }
    }, TX_OPTIONS);
  }

  const totals = { linked: 0, parentFilled: 0, linksChanged: 0, parentsChanged: 0 };
  let done = 0;
  for (const batch of batches) {
    // Counted per batch and added to the totals only once the batch has committed.
    const got = { linked: 0, parentFilled: 0, linksChanged: 0, parentsChanged: 0 };
    await prisma.$transaction(async (db) => {
      await setTimeouts(db);

      // M4: the units this batch links, re-read and share-locked before any write.
      const keys = [...new Set(batch.links.map((l) => l.nameKey))];
      const idByKey = new Map();
      if (keys.length > 0) {
        for (const r of await db.$queryRawUnsafe(UNITS_FOR_SHARE, tenantId, keys)) {
          idByKey.set(r.nameKey, r.id);
        }
      }
      // The parents this batch fills against, re-read and share-locked: factor and product must hold.
      const parentIds = [
        ...new Set(batch.parentFills.map((f) => f.parentUnitId).filter((id) => id != null)),
      ];
      const parentById = new Map();
      if (parentIds.length > 0) {
        for (const r of await db.$queryRawUnsafe(PARENTS_FOR_SHARE, tenantId, parentIds)) {
          parentById.set(r.id, r);
        }
      }

      for (const l of batch.links) {
        const tenantUnitId = idByKey.get(l.nameKey);
        // The unit was deleted (or never committed) since planning: not ours to recreate here.
        if (!tenantUnitId) {
          got.linksChanged += 1;
          continue;
        }
        requireIds(l.productUnitId, tenantUnitId);
        const res = await db.productUnit.updateMany({
          // `label` pins the value the plan was built from: a level renamed since planning updates
          // 0 rows and is counted as changed, never linked on a stale view.
          where: { id: l.productUnitId, tenantId, tenantUnitId: null, label: l.label },
          data: { tenantUnitId },
        });
        if (res.count > 0) got.linked += res.count;
        else got.linksChanged += 1;
      }

      for (const f of batch.parentFills) {
        requireIds(f.productUnitId);
        if (f.parentUnitId != null) {
          const p = parentById.get(f.parentUnitId);
          if (!p || p.productId !== f.productId || p.factorToBase !== f.parentFactor) {
            got.parentsChanged += 1;
            continue;
          }
        }
        const res = await db.productUnit.updateMany({
          // Compare-and-set: still no perParent, the same factor, and the same parent (NULL included)
          // as planned. Anything else moved since planning and is left alone.
          where: {
            id: f.productUnitId,
            tenantId,
            perParent: null,
            factorToBase: f.factorToBase,
            parentUnitId: f.fromParentUnitId,
          },
          data: { parentUnitId: f.parentUnitId, perParent: f.perParent },
        });
        if (res.count > 0) got.parentFilled += res.count;
        else got.parentsChanged += 1;
      }
    }, TX_OPTIONS);
    for (const k of Object.keys(totals)) totals[k] += got[k];
    done += 1;
    if (onBatch) onBatch(done, batches.length);
  }
  return { batches: batches.length, ...totals };
}

module.exports = { applyTenantUnitsPlan, batchWrites, BACKFILL_BATCH_SIZE, WRITE_TIMEOUTS };
