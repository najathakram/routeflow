// READ-ONLY diagnostic + proposal: which products should carry a pack size
// (`Product.unitsPerBox`) so the apps can sell LOOSE PIECES out of a case.
//
// Why this exists: every loose-piece affordance in web and mobile — the
// Cases/Units toggle, the loose stepper, piece-barcode scanning, per-piece
// price proration — switches on `unitsPerBox > 1`. A product named "…12CT"
// whose unit noun is "box" but whose unitsPerBox is unset reads as packaged to
// a human and as a single indivisible unit to the code: one qty stepper, whole
// boxes only. Most catalogues were imported without the field.
//
// What a pack size does and does NOT change:
//   - DOES NOT change the box price. `pricePerUnit` stays the price of one box.
//   - DOES let a piece be sold at `pricePerUnit / unitsPerBox` (prorated by
//     computeLineSubtotal), and turns on the loose-piece UI.
//   So for a catalogue that already prices per box, setting the pack size is
//   additive. The one thing to check per row is exactly that: is `pricePerUnit`
//   the BOX price? The report prints the implied per-piece price so a human can
//   eyeball it.
//
// Confidence tiers, because a wrong pack size mis-prices every loose sale:
//   HIGH   — an explicit count in the name ("12CT", "24 PK", "10 COUNT") AND a
//            pack-ish unit noun, or an existing unitSku (piece barcode).
//   MEDIUM — an explicit count in the name, but the unit noun says nothing.
//   LOW    — pack-ish unit noun with NO count anywhere. Nothing to infer from;
//            listed for manual entry only, never auto-proposed.
//
// NOTHING IS WRITTEN without --execute, and --execute additionally requires
// --confirm-tenant=<slug> typed back. Default output is a report to review.
//
// #2717 M1 (SA-572e, #2728 M1 follow-up): `Product.unitsPerBox` is mirrored into `ProductBarcode`
// rows by the app's own dual-write (products.service.ts) and by the one-time backfill
// (backfill-product-catalog-rows.ts) — those rows are a MIRROR of the legacy column, never a second
// source of truth. Writing `unitsPerBox` here with raw SQL bypasses that sync, so this script clears
// this product's `ProductBarcode` rows in the SAME transaction as the `unitsPerBox` write: the
// product falls back to being row-less (read-model fallback = `synthesizeLegacyBarcodes`, planned
// fresh from the just-written column) until the next backfill run re-mirrors it. Never leave a stale
// row (planned from the OLD unitsPerBox) sitting next to a legacy column that has already moved on.
//
//   railway run --service postgres node apps/api/scripts/propose-pack-sizes.mjs
//   ... --tenant=<slug>          scope to one tenant (default: all ACTIVE)
//   ... --min-confidence=HIGH    only propose HIGH rows (default: HIGH)
//   ... --limit=50               cap rows printed per tier (default: 40)
//
// The classifier (`parsePackSizeDetailed`, `classify`, PACKISH_UNIT / PIECE_UNIT) lives in
// ./lib/pack-size-classifier.mjs, shared with report-units-fold-readiness.mjs (SA-984 C-2): one implementation,
// never a copy. It is a MIRROR of `packages/types/pack-size.ts` (`parsePackSizeDetailed` / `suggestPackSize`), the
// canonical implementation consumed by apps/api, apps/web, and apps/mobile; the lib keeps its own copy only because
// the scripts run standalone under plain `node` (via `railway run`) and cannot import the TS package. Any behavioural
// change belongs in `packages/types/pack-size.ts` first, ported to the lib in step - never the other way around.
import { createRequire } from "module";
import { classify, parsePackSize, parsePackSizeDetailed } from "./lib/pack-size-classifier.mjs";

// Re-exported so the names this file always exported keep resolving.
export { parsePackSize, parsePackSizeDetailed };
const req = createRequire(import.meta.url);
const { Client } = req("pg");
// Row 195: --execute writes through the protected-tenant guard (no override exists for this script).
const { loadProtectedSlugs } = req("./lib/protected-slugs.cjs");
const { assertWritableTenant, ProtectedTenantError } = req("./lib/live-target-guard.cjs");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const EXECUTE = args.execute === true;
const TENANT = typeof args.tenant === "string" ? args.tenant : null;
const LIMIT = Number(args.limit ?? 40);
const MIN_CONFIDENCE = String(args["min-confidence"] ?? "HIGH").toUpperCase();

const url =
  process.env.DATABASE_URL ||
  (process.env.POSTGRES_PASSWORD && process.env.RAILWAY_TCP_PROXY_DOMAIN
    ? `postgresql://${process.env.POSTGRES_USER || "postgres"}:${encodeURIComponent(
        process.env.POSTGRES_PASSWORD,
      )}@${process.env.RAILWAY_TCP_PROXY_DOMAIN}:${process.env.RAILWAY_TCP_PROXY_PORT}/${
        process.env.POSTGRES_DB || "railway"
      }`
    : null);
if (!url) {
  console.error("No DATABASE_URL — run via `railway run --service postgres`.");
  process.exit(1);
}

// Loaded once, from the URL this script dials, before connecting. Only a write needs it.
let protectedSlugs = null;
if (EXECUTE) {
  try {
    protectedSlugs = loadProtectedSlugs(process.env, url);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

const client = new Client({ connectionString: url });
await client.connect();

const { rows: tenants } = await client.query(
  `SELECT t.id, t.slug, t.status, t.class, t."deletedAt", s."planKey", s."stripeSubId", s."couponFull"
     FROM "Tenant" t LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
    WHERE ${TENANT ? "t.slug = $1" : "t.status = 'ACTIVE'"}
    ORDER BY t.slug`,
  TENANT ? [TENANT] : [],
);
if (!tenants.length) {
  console.error(TENANT ? `No tenant with slug "${TENANT}".` : "No active tenants.");
  process.exit(1);
}

const money = (n) => `$${Number(n).toFixed(2)}`;
let grandProposed = 0;

for (const t of tenants) {
  const { rows: products } = await client.query(
    `SELECT id, name, sku, "unitSku", unit, "unitsPerBox", "pricePerUnit"
       FROM "Product"
      WHERE "tenantId" = $1 AND "isActive" = true
        AND ("unitsPerBox" IS NULL OR "unitsPerBox" <= 1)
      ORDER BY name`,
    [t.id],
  );

  const tiers = { HIGH: [], MEDIUM: [], AMBIGUOUS: [], PIECE_UNIT: [], LOW: [] };
  for (const p of products) {
    const c = classify(p);
    if (!c) continue;
    tiers[c.confidence].push({ ...p, packSize: c.packSize, counts: c.counts });
  }

  const total = Object.values(tiers).reduce((s, r) => s + r.length, 0);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`TENANT ${t.slug} — ${products.length} active products without a pack size`);
  console.log(`${"=".repeat(72)}`);
  if (!total) {
    console.log("  Nothing to propose.");
    continue;
  }

  const TIER_NOTE = {
    LOW:
      "   Unit noun implies a pack but nothing states the count. NOT proposed —\n" +
      "   set these by hand (or from the order screen) once you know the pack size.",
    AMBIGUOUS:
      '   The name states TWO different counts (e.g. "5CT - 12Pack" = 12 packs of 5),\n' +
      "   so which one the price refers to is a guess. NOT proposed — set by hand.",
    PIECE_UNIT:
      "   Sold by the piece already (unit is pcs/ea/bottle/…). The count in the name\n" +
      "   describes the case these were broken out of. NOT proposed — a pack size here\n" +
      "   would divide the piece price and undercharge.",
  };
  for (const tier of ["HIGH", "MEDIUM", "AMBIGUOUS", "PIECE_UNIT", "LOW"]) {
    const rows = tiers[tier];
    if (!rows.length) continue;
    console.log(`\n── ${tier} — ${rows.length} product(s)`);
    if (TIER_NOTE[tier]) console.log(TIER_NOTE[tier]);
    for (const r of rows.slice(0, LIMIT)) {
      const box = Number(r.pricePerUnit);
      const per = r.packSize ? box / r.packSize : null;
      const perTxt = per != null ? ` → piece ${money(per)}` : "";
      console.log(
        `   ${r.packSize ? String(r.packSize).padStart(4) : "   ?"} | ${money(box).padStart(9)}${perTxt.padEnd(20)} | unit "${r.unit ?? ""}" | ${r.name}`,
      );
    }
    if (rows.length > LIMIT) console.log(`   … and ${rows.length - LIMIT} more (raise --limit)`);
  }

  const proposable = tiers.HIGH.length + (MIN_CONFIDENCE === "MEDIUM" ? tiers.MEDIUM.length : 0);
  grandProposed += proposable;
  console.log(
    `\n   SUMMARY ${t.slug}: ${tiers.HIGH.length} HIGH · ${tiers.MEDIUM.length} MEDIUM · ${tiers.LOW.length} LOW` +
      `  →  ${proposable} would be set at --min-confidence=${MIN_CONFIDENCE}`,
  );

  if (EXECUTE) {
    const confirm = args["confirm-tenant"];
    if (confirm !== t.slug) {
      console.log(`   ⚠ SKIPPED WRITE: pass --confirm-tenant=${t.slug} to apply to this tenant.`);
      continue;
    }
    // Row 195: a paying / Stripe-linked / PROTECTED_TENANT_SLUGS tenant is never written here.
    try {
      assertWritableTenant(t, t, protectedSlugs);
    } catch (e) {
      if (!(e instanceof ProtectedTenantError)) throw e;
      console.log(`   ⚠ SKIPPED WRITE: ${e.message}`);
      continue;
    }
    const apply = [...tiers.HIGH, ...(MIN_CONFIDENCE === "MEDIUM" ? tiers.MEDIUM : [])];
    let n = 0;
    for (const r of apply) {
      // #2717 M1 (SA-572e): the unitsPerBox write and the mirror-clearing delete happen in ONE
      // transaction on this same client — either both land or neither does, so the legacy column
      // and its ProductBarcode mirror (or lack of one) can never observably disagree.
      await client.query("BEGIN");
      try {
        // Re-assert the precondition inside the write: never overwrite a pack size
        // someone set between the report and the run.
        const res = await client.query(
          `UPDATE "Product" SET "unitsPerBox" = $1, "updatedAt" = now()
            WHERE id = $2 AND "tenantId" = $3
              AND ("unitsPerBox" IS NULL OR "unitsPerBox" <= 1)`,
          [r.packSize, r.id, t.id],
        );
        if (res.rowCount > 0) {
          await client.query(
            `DELETE FROM "ProductBarcode" WHERE "productId" = $1 AND "tenantId" = $2`,
            [r.id, t.id],
          );
        }
        await client.query("COMMIT");
        n += res.rowCount;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    }
    console.log(`   ✅ APPLIED pack size to ${n} product(s) on ${t.slug}.`);
  }
}

console.log(
  EXECUTE
    ? "\nDone."
    : `\nDRY RUN — nothing written. ${grandProposed} product(s) would be set at --min-confidence=${MIN_CONFIDENCE}.\n` +
        `Review the rows above (especially that the price shown is the BOX price), then re-run with:\n` +
        `  --execute --confirm-tenant=<slug>\n`,
);

await client.end();
