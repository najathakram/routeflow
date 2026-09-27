/**
 * READ-ONLY census for #2533: Product rows whose `imageKeys` hold a key OUTSIDE that product's own
 * storage prefix (`products/<productId>/<one segment>`, the only shape the upload path mints).
 *
 * Before #2533, `PATCH /products/:id` stored any key list verbatim and the server signed whatever
 * was stored, so a planted key (another tenant's logo, payment image or PDF) became a working
 * signed URL. The fix refuses such keys on write and never signs them on read. This report tells
 * the owner whether any row was ALREADY poisoned before it shipped.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-2533-product-image-keys.mjs
 *   ... add --json for machine-readable output, --tenant <tenantId> to scope it.
 *   node apps/api/scripts/report-2533-product-image-keys.mjs --self-test   (no database)
 *
 * WHICH DATABASE: the shared report resolver (scripts/lib/report-db-url.mjs, B768): the Railway
 * proxy variables win, and the target is printed (password redacted) before anything is read.
 *
 * WHAT IT PRINTS: per tenant (anonymous labels, A, B, …; no slug or name leaves the process), the
 * number of products and keys outside their own prefix, split by what the key points at:
 *   - OTHER_TENANT_PRODUCT: another tenant's product prefix (a cross-tenant read if signed);
 *   - SAME_TENANT_PRODUCT: another product of the same tenant;
 *   - OTHER_PREFIX: anything else (tenants/…, payments/…, traversal, a foreign shape).
 * With --json it also lists the product ids (never the key values: they are other tenants' paths).
 * Live and approved-test tenants are reported in separate blocks.
 *
 * SAFETY: `default_transaction_read_only = on`, a statement timeout, and SELECTs only. It writes
 * nothing, and it never signs, reads or deletes a stored file.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const NAME = "report-2533-product-image-keys";

/** Mirrors src/products/product-image-keys.ts `isOwnProductImageKey`. */
export function isOwnKey(productId, key) {
  if (typeof key !== "string" || !productId) return false;
  const prefix = `products/${productId}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) return false;
  const rest = key.slice(prefix.length);
  return !rest.includes("/") && !rest.includes("\\") && rest !== "." && rest !== "..";
}

/**
 * Classify one foreign key. `productTenant` maps every product id to its tenant id.
 * @returns "OTHER_TENANT_PRODUCT" | "SAME_TENANT_PRODUCT" | "OTHER_PREFIX"
 */
export function classify(key, tenantId, productTenant) {
  const m = /^products\/([^/]+)\//.exec(key);
  if (!m || key.includes("..")) return "OTHER_PREFIX";
  const owner = productTenant.get(m[1]);
  if (!owner) return "OTHER_PREFIX";
  return owner === tenantId ? "SAME_TENANT_PRODUCT" : "OTHER_TENANT_PRODUCT";
}

/** Group rows { tenantId, productId, key, kind } into anonymous per-tenant counts. */
export function summarize(rows) {
  const label = new Map();
  const byTenant = new Map();
  for (const r of rows) {
    if (!label.has(r.tenantId))
      label.set(
        r.tenantId,
        `tenant ${String.fromCharCode(65 + (label.size % 26))}${label.size >= 26 ? Math.floor(label.size / 26) : ""}`,
      );
    const t = byTenant.get(r.tenantId) ?? {
      tenant: label.get(r.tenantId),
      products: new Set(),
      keys: 0,
      OTHER_TENANT_PRODUCT: 0,
      SAME_TENANT_PRODUCT: 0,
      OTHER_PREFIX: 0,
    };
    t.products.add(r.productId);
    t.keys++;
    t[r.kind]++;
    byTenant.set(r.tenantId, t);
  }
  const detail = [...byTenant.values()].map((t) => ({
    ...t,
    productIds: [...t.products],
    products: t.products.size,
  }));
  return {
    tenants: detail.length,
    products: detail.reduce((n, d) => n + d.products, 0),
    keys: detail.reduce((n, d) => n + d.keys, 0),
    crossTenant: detail.reduce((n, d) => n + d.OTHER_TENANT_PRODUCT, 0),
    detail,
  };
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(isOwnKey("p1", "products/p1/a.jpg"), true, "own");
  eq(isOwnKey("p1", "products/p2/a.jpg"), false, "other product");
  eq(isOwnKey("p1", "products/p1/../x/a.jpg"), false, "traversal");
  eq(isOwnKey("p1", "products/p1/"), false, "bare prefix");
  eq(isOwnKey("p1", "tenants/t1/logo.png"), false, "tenant file");
  const owners = new Map([
    ["p1", "t1"],
    ["p2", "t1"],
    ["p9", "t2"],
  ]);
  eq(classify("products/p9/a.jpg", "t1", owners), "OTHER_TENANT_PRODUCT", "cross-tenant");
  eq(classify("products/p2/a.jpg", "t1", owners), "SAME_TENANT_PRODUCT", "same tenant");
  eq(classify("tenants/t2/logo.png", "t1", owners), "OTHER_PREFIX", "other prefix");
  eq(classify("products/p1/../../tenants/x", "t1", owners), "OTHER_PREFIX", "traversal");
  const s = summarize([
    { tenantId: "t1", productId: "p1", key: "k", kind: "OTHER_TENANT_PRODUCT" },
    { tenantId: "t1", productId: "p1", key: "k2", kind: "OTHER_PREFIX" },
  ]);
  eq([s.tenants, s.products, s.keys, s.crossTenant], [1, 1, 2, 1], "summary");
  if (JSON.stringify(s).includes('"k"')) throw new Error("summary leaked a key value");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const known = new Set(["--json", "--tenant", "--self-test"]);
  const tenantArg = argv.indexOf("--tenant");
  const onlyTenant = tenantArg >= 0 ? argv[tenantArg + 1] : null;
  for (const [i, a] of argv.entries())
    if (a.startsWith("--") && !known.has(a)) {
      console.error(`${NAME}: unknown argument ${a}`);
      process.exit(2);
    } else if (!a.startsWith("--") && argv[i - 1] !== "--tenant") {
      console.error(`${NAME}: unexpected argument ${a}`);
      process.exit(2);
    }
  if (tenantArg >= 0 && !onlyTenant) {
    console.error(`${NAME}: --tenant needs a tenant id`);
    process.exit(2);
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");

    const { rows: keys } = await client.query(
      `SELECT p."tenantId", t.slug, p.id AS "productId", k.key
         FROM "Product" p
         JOIN "Tenant" t ON t.id = p."tenantId"
         CROSS JOIN LATERAL unnest(p."imageKeys") AS k(key)
        WHERE ($1::text IS NULL OR p."tenantId" = $1::text)
        ORDER BY p."tenantId", p.id`,
      [onlyTenant],
    );
    const foreign = keys.filter((r) => !isOwnKey(r.productId, r.key));
    // Owners of any product a foreign key points into (one lookup, ids only).
    const pointed = [
      ...new Set(foreign.map((r) => /^products\/([^/]+)\//.exec(r.key)?.[1]).filter(Boolean)),
    ];
    const { rows: owners } = pointed.length
      ? await client.query(`SELECT id, "tenantId" FROM "Product" WHERE id = ANY($1::text[])`, [
          pointed,
        ])
      : { rows: [] };
    const productTenant = new Map(owners.map((o) => [o.id, o.tenantId]));
    const classified = foreign.map((r) => ({
      ...r,
      kind: classify(r.key, r.tenantId, productTenant),
    }));

    const report = {
      scanned: { products: new Set(keys.map((k) => k.productId)).size, keys: keys.length },
      live: summarize(classified.filter((r) => !isTestTenant(r.slug))),
      test: summarize(classified.filter((r) => isTestTenant(r.slug))),
    };
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `${NAME}: scanned ${report.scanned.products} product(s) with images, ${report.scanned.keys} key(s)`,
    );
    for (const block of ["live", "test"]) {
      const s = report[block];
      console.log(
        `${block}: ${s.keys} key(s) outside their product's prefix on ${s.products} product(s) across ${s.tenants} tenant(s); ${s.crossTenant} point into ANOTHER tenant's product`,
      );
      for (const d of s.detail)
        console.log(
          `  ${d.tenant}  ${d.products} product(s), ${d.keys} key(s): other-tenant ${d.OTHER_TENANT_PRODUCT}, same-tenant ${d.SAME_TENANT_PRODUCT}, other prefix ${d.OTHER_PREFIX}`,
        );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** True when this module is the process entry point (not imported by a spec). */
export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return (
    norm(entry) === norm(self) || basename(entry).toLowerCase() === basename(self).toLowerCase()
  );
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
