/**
 * Shared identity for the `routeflow-demo` sales-demo tenant.
 *
 * Every row the demo scripts write gets a UUID derived from a stable hash of its
 * natural key, so a re-seed addresses the same rows instead of duplicating them,
 * and a second script (the image uploader) can work out a product's demo id from
 * the source id alone — no map file to keep in sync or lose.
 *
 * Consumed by apps/api/scripts/demo-seed.js and demo-seed-images.js.
 */

const crypto = require("crypto");

const DEMO_SLUG = "routeflow-demo";

/**
 * A UUIDv5-shaped id derived from (namespace, key). Not RFC 4122 v5 — it uses a
 * fixed private prefix rather than a namespace UUID — but it is stable, collision
 * resistant, and valid for a Postgres uuid column, which is all this needs.
 */
function stableId(namespace, key) {
  const b = Buffer.from(
    crypto.createHash("sha1").update(`${DEMO_SLUG}:${namespace}:${key}`).digest().subarray(0, 16),
  );
  b[6] = (b[6] & 0x0f) | 0x50; // version
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The demo-tenant product id that corresponds to a source-tenant product id. */
const demoProductId = (sourceProductId) => stableId("product", sourceProductId);

module.exports = { DEMO_SLUG, stableId, demoProductId };
