// Backfill legacy ProductMapping rows into ProductAlias.
//
// WHY: ProductAlias is the tenant-safe, normalized replacement for the legacy
// global ProductMapping table (see product-alias.service.ts). resolve() has
// never been backfilled from the legacy data, so operators who already taught
// ProductMapping corrections get none of that memory back on the new tier.
//
// SAFETY: dry-run by default; pass --apply to write. Writes via
// createMany({ skipDuplicates: true }) so re-running is idempotent — it can
// never overwrite or duplicate an existing ProductAlias row. Rows with a NULL
// tenantId or NULL productId are skipped and reported (ProductAlias.tenantId
// is required, and an alias with no target is worthless). Supplier resolution
// is matched per-tenant over ACTIVE suppliers only (what the runtime's
// VendorBillsService.resolveSupplierId sees) against the same three-tier logic
// as import's supplier-match.ts (exact -> unique startsWith -> unique
// contains); a row whose supplier can't be confidently resolved is SKIPPED and
// reported, never promoted to the any-supplier ("") scope — resolveMany()
// always reads that scope, so one supplier's correction would start answering
// for every other supplier in the tenant, and the scope stays reserved for
// batch-import's own any-supplier aliases. Skipped rows keep working through
// the legacy ProductMapping read tier, which this backfill leaves untouched.
//
// Grouping: legacy rows are grouped by (tenantId, resolvedSupplierId,
// normalizedRawText) — the same tuple ProductAlias's unique constraint uses —
// and on a collision within a group the most recently updatedAt row wins. A
// collision report (count + a sample) is always printed in dry-run so the
// owner can eyeball it before writing.
//
// Run (dry-run): railway run --service postgres node apps/api/scripts/backfill-product-aliases.mjs
// Run (write):   railway run --service postgres node apps/api/scripts/backfill-product-aliases.mjs --apply
import { readFile } from "node:fs/promises";
import pg from "pg";
import guard from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";

// Row 195: protected tenants (paying | stripe-linked | PROTECTED_TENANT_SLUGS) are never given
// aliases by this script. Dry-run and apply plan the same set. Counts only, never a slug.
const { protectedTenantIds } = guard;
const { loadProtectedSlugs } = protectedSlugsLib;

const APPLY = process.argv.includes("--apply");

const e = process.env;
const railwayParts = [
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "RAILWAY_TCP_PROXY_DOMAIN",
  "RAILWAY_TCP_PROXY_PORT",
];
const connectionString =
  e.DATABASE_URL ||
  (railwayParts.every((k) => e[k])
    ? `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
      `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
    : null);

if (!connectionString) {
  console.error(
    `Missing DATABASE_URL (or ${railwayParts.join(", ")}).\n` +
      "Run via:  railway run --service postgres node apps/api/scripts/backfill-product-aliases.mjs [--apply]",
  );
  process.exit(1);
}

// Must match ProductAliasService.normalize() exactly — a drifted copy writes
// aliases that resolve() can never look up. The literal is checked against the
// live service source below and the script aborts on drift.
const normalize = (raw) => (raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");

// A backfill that normalizes differently from ProductAliasService silently
// writes dead aliases, so the literal is checked against the live service
// source where readable; a missing source only warns, per house convention
// (backfill-supplier-invoice-number.mjs), so a source-less host can't be a
// reason for the whole script to abort. (The supplier ladder below is a hand
// mirror of supplier-match.ts — keep the two tier-for-tier by hand.)
const assertInSyncWithService = async () => {
  const url = new URL("../src/import/product-alias.service.ts", import.meta.url);
  let src;
  try {
    src = await readFile(url, "utf8");
  } catch {
    console.warn("WARN: product-alias.service.ts unreadable here — drift check skipped.\n");
    return;
  }
  const normalizeBody = normalize.toString().split("=>")[1].trim();
  if (!src.includes(normalizeBody)) {
    console.error(
      "ABORT: normalize() no longer matches ProductAliasService.normalize(). " +
        "Re-sync this script first.",
    );
    process.exit(2);
  }
};

// Exact -> unique startsWith -> unique contains, mirroring import's
// supplier-match.ts (WP2) tier for tier: both sides trimmed and lower-cased,
// and an AMBIGUOUS startsWith tier returns null instead of falling through to
// contains. A ladder that drifts from the runtime resolver writes aliases the
// scan path can never resolve.
const matchSupplier = (rawName, suppliers) => {
  const d = (rawName ?? "").trim().toLowerCase();
  if (!d || !suppliers.length) return null;
  const exact = suppliers.filter((s) => s.name.trim().toLowerCase() === d);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const startsWith = suppliers.filter(
    (s) => s.name.trim().toLowerCase().startsWith(d) || d.startsWith(s.name.trim().toLowerCase()),
  );
  if (startsWith.length === 1) return startsWith[0].id;
  if (startsWith.length > 1) return null;
  const contains = suppliers.filter((s) => {
    const n = s.name.trim().toLowerCase();
    return n.includes(d) || d.includes(n);
  });
  return contains.length === 1 ? contains[0].id : null;
};

await assertInSyncWithService();

// Loaded ONCE, against the URL this script dials, before connecting.
const protectedSlugs = loadProtectedSlugs(process.env, connectionString);
const client = new pg.Client({ connectionString });

try {
  await client.connect();
  console.log(APPLY ? "MODE: APPLY (will write)\n" : "MODE: dry-run (no writes)\n");

  const { rows: legacyRows } = await client.query(
    `SELECT id, "tenantId", "supplierName", "rawDescription", "productId", "updatedAt"
     FROM "ProductMapping"
     ORDER BY "tenantId", "updatedAt" DESC`,
  );
  console.log(`Legacy ProductMapping rows: ${legacyRows.length}`);

  const skippedNullTenant = legacyRows.filter((r) => !r.tenantId);
  const skippedNullProduct = legacyRows.filter((r) => r.tenantId && !r.productId);
  const protectedIds = new Set(await protectedTenantIds(client, protectedSlugs));
  const skippedProtected = legacyRows.filter((r) => r.tenantId && protectedIds.has(r.tenantId));
  const candidates = legacyRows.filter(
    (r) => r.tenantId && r.productId && !protectedIds.has(r.tenantId),
  );
  console.log(
    `Skipped (NULL tenantId): ${skippedNullTenant.length}, ` +
      `skipped (NULL productId): ${skippedNullProduct.length}, ` +
      `skipped (protected tenant): ${skippedProtected.length}, ` +
      `candidates: ${candidates.length}`,
  );

  // Suppliers, grouped per tenant, for the match pass. ACTIVE only —
  // VendorBillsService.resolveSupplierId matches against `isActive: true`, so
  // an alias written under a deactivated supplier's id is dead on arrival.
  const { rows: supplierRows } = await client.query(
    `SELECT id, "tenantId", name FROM "Supplier" WHERE "isActive" = true`,
  );
  const suppliersByTenant = new Map();
  for (const s of supplierRows) {
    const list = suppliersByTenant.get(s.tenantId) ?? [];
    list.push(s);
    suppliersByTenant.set(s.tenantId, list);
  }

  // Group by (tenantId, resolvedSupplierId, normalizedRawText); keep the most
  // recently updated row on collision.
  const groups = new Map();
  const collisions = [];
  const unresolvedSupplier = [];
  for (const row of candidates) {
    const suppliers = suppliersByTenant.get(row.tenantId) ?? [];
    const resolvedSupplierId = matchSupplier(row.supplierName, suppliers);
    if (!resolvedSupplierId) {
      // Deliberately NOT falling back to the "" any-supplier scope: it answers
      // for every supplier in the tenant, so a correction learned for one
      // supplier would auto-match another supplier's invoice at high
      // confidence. The row stays on the legacy ProductMapping tier instead.
      unresolvedSupplier.push(row);
      continue;
    }
    const normalized = normalize(row.rawDescription);
    if (!normalized) continue;
    const key = `${row.tenantId}\u0000${resolvedSupplierId}\u0000${normalized}`;
    const enriched = { ...row, resolvedSupplierId, normalized };
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, enriched);
    } else {
      collisions.push({ key, kept: existing, dropped: enriched });
      if (new Date(enriched.updatedAt) > new Date(existing.updatedAt)) {
        groups.set(key, enriched);
      }
    }
  }

  console.log(`Distinct (tenantId, supplierId, rawText) groups: ${groups.size}`);

  if (unresolvedSupplier.length) {
    console.log(
      `\nSkipped (supplier name did not resolve to an active Supplier — left on ` +
        `the legacy ProductMapping tier): ${unresolvedSupplier.length}`,
    );
    for (const r of unresolvedSupplier.slice(0, 10)) {
      console.log(
        `  tenant=${r.tenantId} supplierName=${JSON.stringify(r.supplierName)} ` +
          `raw=${JSON.stringify(r.rawDescription)}`,
      );
    }
    if (unresolvedSupplier.length > 10) {
      console.log(`  ...and ${unresolvedSupplier.length - 10} more`);
    }
  } else {
    console.log("\nSkipped (supplier unresolved): none");
  }

  if (collisions.length) {
    console.log(
      `\nCollisions (duplicate legacy rows mapping to the same alias key): ${collisions.length}`,
    );
    for (const c of collisions.slice(0, 10)) {
      console.log(
        `  key=${c.key.replace(/\u0000/g, " | ")} kept=${c.kept.id} (updatedAt=${c.kept.updatedAt}) ` +
          `dropped=${c.dropped.id} (updatedAt=${c.dropped.updatedAt})`,
      );
    }
    if (collisions.length > 10) {
      console.log(`  ...and ${collisions.length - 10} more`);
    }
  } else {
    console.log("\nCollisions: none");
  }

  const toInsert = [...groups.values()].map((g) => ({
    tenantId: g.tenantId,
    supplierId: g.resolvedSupplierId,
    rawText: g.normalized,
    productId: g.productId,
  }));

  if (!APPLY) {
    console.log(
      `\nDry-run: would insert up to ${toInsert.length} ProductAlias row(s) ` +
        "(createMany/skipDuplicates — existing rows are left untouched).\n" +
        "Re-run with --apply to write.",
    );
  } else {
    let written = 0;
    await client.query("BEGIN");
    try {
      const BATCH = 500;
      for (let i = 0; i < toInsert.length; i += BATCH) {
        const slice = toInsert.slice(i, i + BATCH);
        const values = slice
          .map(
            (_, n) =>
              `(gen_random_uuid(), $${n * 4 + 1}::text, $${n * 4 + 2}::text, $${n * 4 + 3}::text, $${n * 4 + 4}::text, now(), now())`,
          )
          .join(", ");
        const params = slice.flatMap((r) => [r.tenantId, r.supplierId, r.rawText, r.productId]);
        const res = await client.query(
          `INSERT INTO "ProductAlias" (id, "tenantId", "supplierId", "rawText", "productId", "createdAt", "updatedAt")
           VALUES ${values}
           ON CONFLICT ("tenantId", "supplierId", "rawText") DO NOTHING`,
          params,
        );
        written += res.rowCount ?? 0;
        console.log(`  batch ${i / BATCH + 1}: ${res.rowCount ?? 0} row(s) inserted`);
      }
      await client.query("COMMIT");
      console.log(
        `\nInserted: ${written} of ${toInsert.length} candidate(s) ` +
          `(remainder were pre-existing aliases — skipDuplicates semantics).`,
      );
      console.log("Backfill complete.");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
} finally {
  await client.end();
}
