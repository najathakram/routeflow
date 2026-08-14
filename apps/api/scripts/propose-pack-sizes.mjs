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
//   railway run --service postgres node apps/api/scripts/propose-pack-sizes.mjs
//   ... --tenant=<slug>          scope to one tenant (default: all ACTIVE)
//   ... --min-confidence=HIGH    only propose HIGH rows (default: HIGH)
//   ... --limit=50               cap rows printed per tier (default: 40)
import { createRequire } from "module";
const { Client } = createRequire(import.meta.url)("pg");

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

/**
 * Pull a pack size out of a product name. Deliberately conservative: only
 * patterns that state a COUNT of pieces. Ambiguous multi-number names
 * ("2/12", "5 HOUR") are rejected rather than guessed, because a wrong pack
 * size mis-prices every loose sale of that product.
 *
 * Mirrors apps/mobile/lib/pack-size.ts — keep the two in step.
 */
export function parsePackSize(name) {
  const r = parsePackSizeDetailed(name);
  return r.packSize;
}

/**
 * Returns { packSize, counts } where `counts` is every distinct count-like token
 * found. More than one DISTINCT count means the name describes nested packaging
 * ("5CT - 12Pack" = 12 packs of 5) and we cannot tell which number the price
 * refers to — so packSize comes back null and the row is reported AMBIGUOUS
 * rather than guessed. Guessing here mis-prices every loose sale of that
 * product, which is worse than leaving it for a human.
 */
export function parsePackSizeDetailed(name) {
  if (!name) return { packSize: null, counts: [] };
  const s = String(name).toUpperCase();
  const counts = [];

  // "12/1.93OZ" — N units of a given size. Read BEFORE measurements are stripped,
  // because the measurement is what identifies this as a pack-of-N.
  for (const m of s.matchAll(/\b(\d{1,4})\s*\/\s*[\d.]+\s*(OZ|ML|L|G|MG|LB|KG|CT)\b/g)) {
    counts.push(Number(m[1]));
  }

  // Strip measurements so "5 HOUR" / "65MG" / "3OZ" can't read as counts.
  const cleaned = s.replace(/\b[\d.]+\s*(HOUR|HR|ML|OZ|LB|KG|MG|G|L|CM|MM|IN|FT|%)\b/g, " ");

  // 12CT / 12 CT / 12-CT / 24PK / 24 PACK / 10 COUNT
  for (const m of cleaned.matchAll(/\b(\d{1,4})\s*[-\s]?\s*(CT|CNT|COUNT|PK|PACK|PCS|PC)\b/g)) {
    counts.push(Number(m[1]));
  }

  const valid = [...new Set(counts.filter((n) => Number.isFinite(n) && n > 1 && n <= 1000))];
  return { packSize: valid.length === 1 ? valid[0] : null, counts: valid };
}

const PACKISH_UNIT = /\b(box|case|carton|pack|pk|ct|dozen|dz|bundle|tray|sleeve|showcase)\b/i;
/** Unit nouns that say "this row IS one piece" — a pack size here would divide
 *  a piece price by the pack and undercharge by that factor. Never propose. */
const PIECE_UNIT = /^\s*(pcs?|pieces?|ea|each|single|singles|unit|units|bottle|can|stick)\s*$/i;

function classify(p) {
  const { packSize, counts } = parsePackSizeDetailed(p.name);
  const unit = String(p.unit ?? "");
  const packishUnit = PACKISH_UNIT.test(unit);
  const pieceUnit = PIECE_UNIT.test(unit);
  const hasPieceBarcode = !!(p.unitSku && String(p.unitSku).trim());

  // A piece-level SKU sold by the piece: the count in its name describes the
  // case it was broken out of, not this row. Report, never propose.
  if (pieceUnit) return { confidence: "PIECE_UNIT", packSize: null, counts };

  // Nested packaging — two different counts, no way to know which the price is.
  if (!packSize && counts.length > 1) return { confidence: "AMBIGUOUS", packSize: null, counts };

  if (packSize && (packishUnit || hasPieceBarcode)) return { confidence: "HIGH", packSize, counts };
  if (packSize) return { confidence: "MEDIUM", packSize, counts };
  if (packishUnit) return { confidence: "LOW", packSize: null, counts };
  return null;
}

const client = new Client({ connectionString: url });
await client.connect();

const { rows: tenants } = await client.query(
  TENANT
    ? `SELECT id, slug FROM "Tenant" WHERE slug = $1`
    : `SELECT id, slug FROM "Tenant" WHERE status = 'ACTIVE' ORDER BY slug`,
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
    const apply = [...tiers.HIGH, ...(MIN_CONFIDENCE === "MEDIUM" ? tiers.MEDIUM : [])];
    let n = 0;
    for (const r of apply) {
      // Re-assert the precondition inside the write: never overwrite a pack size
      // someone set between the report and the run.
      const res = await client.query(
        `UPDATE "Product" SET "unitsPerBox" = $1, "updatedAt" = now()
          WHERE id = $2 AND "tenantId" = $3
            AND ("unitsPerBox" IS NULL OR "unitsPerBox" <= 1)`,
        [r.packSize, r.id, t.id],
      );
      n += res.rowCount;
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
