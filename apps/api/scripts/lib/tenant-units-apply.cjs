/**
 * Write side of scripts/backfill-tenant-units.mjs (units U-6). Takes the pure plan from
 * tenant-units-plan.cjs and applies it through a Prisma-like client (`$transaction`,
 * `$executeRawUnsafe`, `$queryRawUnsafe`, `tenantUnit`, `productUnit`). The tenant id comes from the
 * caller, never from the plan. Inserts and FK links only (SA-729:52): no Product column is written.
 *
 * Shape of a run:
 *   1. ONE small transaction creates the planned TenantUnits (idempotent: skipDuplicates by nameKey).
 *      SA-810: it first re-counts the tenant's ACTIVE units and creates only what still fits under
 *      MAX_ACTIVE_TENANT_UNITS (the plan was made from an earlier read); it never refuses and never
 *      exceeds the cap. The plan lists `toCreate` most used first, so the names cut are the least
 *      used, and they are returned BY NAME (`unitsCappedNames`). A name someone created since
 *      planning is dropped before the cut (it would only waste a slot). A unit left out is not
 *      linked below (the link is reported as `linksOverCap`, not as changed).
 *   2. The ladder links and parent fills are grouped by PRODUCT and applied in batches of
 *      BACKFILL_BATCH_SIZE products, each batch in its own transaction, so no transaction grows with
 *      the size of the catalog and a crash loses at most the batch in flight.
 * Every transaction sets a lock_timeout and a statement_timeout first.
 *
 * LADDER LOCKS (U-1, apps/api/src/units/tenant-units-lock.ts): this script writes ladder data
 * (tenantUnitId links, parentUnitId / perParent fills), so each batch transaction takes what every
 * ladder writer takes, FIRST, before any row lock: the tenant units advisory lock SHARED (a rename
 * holds it EXCLUSIVE, so a rename and a batch never interleave), then the per-product `product-units`
 * lock of every product in the batch, in sorted order (a second backfill of the same tenant locks in
 * the same order, so two cannot deadlock). The SQL below is the same statement text U-1 issues; the
 * script is CommonJS and cannot import the TypeScript, so tenant-units-parity.spec.ts runs U-1's own
 * `lockProductPack` and requires the two to match. The `lock_timeout` set first bounds the wait.
 *
 * Inside each batch, AFTER the locks and BEFORE any write (SA M4): the batch's TenantUnits are re-read by nameKey FOR SHARE
 * (a unit deleted since planning is not linked; the share lock keeps it from being renamed or deleted
 * until COMMIT), every planned parent row is re-read FOR SHARE (its factor and product must still be
 * the planned ones), and for a fill planned with no parent row (the base or the pack) the product's
 * unitsPerBox is re-read FOR SHARE (the pack must still be the planned one).
 *
 * Resume and idempotence: every write is a compare-and-set on the values the plan was built from (a
 * link only where tenantUnitId IS NULL and the label is unchanged; a parent fill only where perParent
 * IS NULL and the factor and parent are unchanged), and the caller re-plans from the database on each
 * run, so a re-run plans only what is still missing. A product's writes always travel in the same
 * batch, so a crash never leaves a product half-done.
 */
"use strict";

const { MAX_ACTIVE_TENANT_UNITS } = require("./tenant-units-plan.cjs");

/**
 * Products per transaction. 200 products is a few hundred single-row statements: comfortably inside
 * the timeouts below, while keeping row locks and rollback cost small. Not a CLI option (the script
 * has no tuning flags); change it here.
 */
const BACKFILL_BATCH_SIZE = 200;

const TX_OPTIONS = { timeout: 60000, maxWait: 10000 };
/** SET LOCAL inside every write transaction: wait at most 5 s for a row lock, 60 s per statement. */
const WRITE_TIMEOUTS = ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '60s'"];

/** `takeTenantLock(tx, tenantId, "shared")` in tenant-units-lock.ts. $1 = the tenant id. */
const TENANT_UNITS_LOCK_SQL =
  "SELECT pg_advisory_xact_lock_shared(hashtext('tenant-units'), hashtext($1))";
/** The per-product lock `lockProductPack` takes right after it. $1 = the product id. */
const PRODUCT_UNITS_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext($1))";

const UNITS_FOR_SHARE = `SELECT id, "nameKey" FROM "TenantUnit"
  WHERE "tenantId" = $1 AND "nameKey" = ANY($2::text[]) FOR SHARE`;
const PARENTS_FOR_SHARE = `SELECT id, "productId", "factorToBase" FROM "ProductUnit"
  WHERE "tenantId" = $1 AND id = ANY($2::text[]) FOR SHARE`;
const PACKS_FOR_SHARE = `SELECT id, "unitsPerBox" FROM "Product"
  WHERE "tenantId" = $1 AND id = ANY($2::text[]) FOR SHARE`;

/** The pack size a product's unitsPerBox stands for: an integer > 1, else none (null). */
const packOf = (unitsPerBox) => {
  const n = Number(unitsPerBox);
  return Number.isInteger(n) && n > 1 ? n : null;
};

/**
 * Group the plan's writes by product, then slice the products into batches of `size`.
 * @param {{ links: Array<{productUnitId: string, nameKey: string}>,
 *           parentFills: Array<{productUnitId: string, productId: string}> }} plan
 * @param {Map<string, string>} productIdByUnit ProductUnit.id -> Product.id
 * @param {number} size products per batch
 * @returns {Array<{ links: Array<object>, parentFills: Array<object>, productIds: string[] }>}
 *   `productIds`: the batch's real products, sorted (the order their locks are taken in).
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
  const unknown = new Set();
  for (const l of plan.links) {
    // A unit whose product is unknown still gets its own slot rather than being dropped.
    const productId = productIdByUnit.get(l.productUnitId);
    if (productId == null) unknown.add(`unit:${l.productUnitId}`);
    slot(productId ?? `unit:${l.productUnitId}`).links.push(l);
  }
  for (const f of plan.parentFills ?? []) slot(f.productId).parentFills.push(f);

  const keys = [...byProduct.keys()].sort();
  const batches = [];
  for (let i = 0; i < keys.length; i += size) {
    const batch = { links: [], parentFills: [], productIds: [] };
    for (const key of keys.slice(i, i + size)) {
      const s = byProduct.get(key);
      batch.links.push(...s.links);
      batch.parentFills.push(...s.parentFills);
      if (!unknown.has(key)) batch.productIds.push(key);
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
 * @returns {Promise<{ batches: number, unitsCreated: number, unitsCapped: number,
 *                     unitsCappedNames: string[], linked: number, parentFilled: number,
 *                     linksChanged: number, linksOverCap: number, parentsChanged: number }>}
 *   linked/parentFilled are rows ACTUALLY written; linksChanged/parentsChanged are planned writes that
 *   were skipped because a row changed since planning (left for a re-run, never overwritten);
 *   linksOverCap are links skipped because their unit was cut by the cap at apply time.
 *   A failure rethrows with `batchesCommitted` and `batchesTotal` set on the error.
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

  // Inserted rows, counted by the database: a unit created by someone else since planning is skipped
  // (the unique (tenantId, nameKey) holds), so this is what the run actually created.
  let unitsCreated = 0;
  // Planned units left out because the room shrank since planning (SA-810), by name.
  const unitsCappedNames = [];
  const cappedKeys = new Set();
  if (plan.toCreate.length > 0) {
    await prisma.$transaction(async (db) => {
      await setTimeouts(db);
      // U-1's unitRoom: the cap minus the tenant's active units. A soft cap under concurrency (a
      // person's add runs under no lock); this transaction is short, so any overshoot stays bounded.
      const active = await db.tenantUnit.count({ where: { tenantId, archivedAt: null } });
      const room = Math.max(0, MAX_ACTIVE_TENANT_UNITS - active);
      // A name that exists NOW (archived included: the unique key spans them) would be skipped by
      // skipDuplicates and still cost a slot in the cut below, so it is dropped first.
      const present = new Set(
        (
          await db.tenantUnit.findMany({
            where: { tenantId, nameKey: { in: plan.toCreate.map((c) => c.nameKey) } },
            select: { nameKey: true },
          })
        ).map((r) => r.nameKey),
      );
      // `plan.toCreate` is most used first: the cut takes the tail, the least used.
      const missing = plan.toCreate.filter((c) => !present.has(c.nameKey));
      const fit = missing.slice(0, room);
      for (const c of missing.slice(room)) {
        unitsCappedNames.push(c.name);
        cappedKeys.add(c.nameKey);
      }
      if (fit.length === 0) return;
      const res = await db.tenantUnit.createMany({
        data: fit.map((c) => ({ tenantId, name: c.name, nameKey: c.nameKey })),
        skipDuplicates: true,
      });
      unitsCreated = res.count;
    }, TX_OPTIONS);
  }

  const applyBatch = (batch, got) => {
    return prisma.$transaction(async (db) => {
      await setTimeouts(db);
      // U-1's ladder locks, FIRST (before any row lock): the tenant units lock SHARED, then every
      // product of the batch, sorted. See the header.
      await db.$executeRawUnsafe(TENANT_UNITS_LOCK_SQL, tenantId);
      for (const productId of batch.productIds) {
        await db.$executeRawUnsafe(PRODUCT_UNITS_LOCK_SQL, productId);
      }

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
      // ...and the pack of every product with a fill planned against no parent row.
      const packProductIds = [
        ...new Set(batch.parentFills.filter((f) => f.parentUnitId == null).map((f) => f.productId)),
      ];
      const packByProduct = new Map();
      if (packProductIds.length > 0) {
        for (const r of await db.$queryRawUnsafe(PACKS_FOR_SHARE, tenantId, packProductIds)) {
          packByProduct.set(r.id, packOf(r.unitsPerBox));
        }
      }

      for (const l of batch.links) {
        const tenantUnitId = idByKey.get(l.nameKey);
        // The unit was deleted (or never committed) since planning: not ours to recreate here.
        if (!tenantUnitId) {
          // cut by the cap just now, or deleted since planning
          if (cappedKeys.has(l.nameKey)) got.linksOverCap += 1;
          else got.linksChanged += 1;
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
        } else if (
          !packByProduct.has(f.productId) ||
          packByProduct.get(f.productId) !== packOf(f.unitsPerBox)
        ) {
          // the product is gone or its pack moved: the base/pack choice no longer holds
          got.parentsChanged += 1;
          continue;
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
  };

  const totals = {
    linked: 0,
    parentFilled: 0,
    linksChanged: 0,
    linksOverCap: 0,
    parentsChanged: 0,
  };
  let done = 0;
  for (const batch of batches) {
    // Counted per batch and added to the totals only once the batch has committed.
    const got = { linked: 0, parentFilled: 0, linksChanged: 0, linksOverCap: 0, parentsChanged: 0 };
    try {
      await applyBatch(batch, got);
    } catch (err) {
      // Say how far the run got: finished batches are committed and a re-run resumes after them.
      if (err && typeof err === "object") {
        err.batchesCommitted = done;
        err.batchesTotal = batches.length;
      }
      throw err;
    }
    for (const k of Object.keys(totals)) totals[k] += got[k];
    done += 1;
    if (onBatch) onBatch(done, batches.length);
  }
  return {
    batches: batches.length,
    unitsCreated,
    unitsCapped: unitsCappedNames.length,
    unitsCappedNames,
    ...totals,
  };
}

module.exports = {
  applyTenantUnitsPlan,
  batchWrites,
  BACKFILL_BATCH_SIZE,
  WRITE_TIMEOUTS,
  TENANT_UNITS_LOCK_SQL,
  PRODUCT_UNITS_LOCK_SQL,
};
