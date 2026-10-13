#!/usr/bin/env node
/**
 * labels-from-categories — give ONE tenant product labels (`ProductCategory`) built from its products'
 * free-text `Product.category`, and label each product with its own text's label (INCLUDE memberships).
 *
 * WHY. Selling-restriction rules target product LABELS. A tenant that only ever typed category text has
 * zero labels, so the rule form's Category list is empty. This tool turns that text into labels once; the
 * add-only sync (`syncCategoryLabel`, run by every Product.category writer) keeps NEW products in step.
 *
 * RULES (SA-approved)
 *   - Normalising: NFC, trim, collapse inner whitespace; the KEY is that, case-folded. Texts with one key
 *     are one label, named by the most common casing (ties: code-point order, so a capitalised form wins). Case variants that
 *     merged are LISTED. Nothing else merges (no fuzzy match). Blank text gets no label.
 *   - A key that matches an EXISTING label (by the same key) reuses it; when only ARCHIVED labels match it is
 *     listed and skipped (never unarchived); case-duplicate labels sharing one key are never merged: the
 *     OLDEST unarchived one is used (as the sync does) and the ambiguity is listed.
 *   - Memberships are written ONLY through the single label writer (`addIncludeIfAbsent`, compiled from
 *     apps/api/src/product-categories/label-writer.ts): an INCLUDE when the product has NO row for that
 *     label; an existing INCLUDE or opt-out (EXCLUDE) is left exactly as it is. A re-run plans 0.
 *   - `Product.category` is never written. No label is ever renamed, archived or deleted.
 *   - Output: counts and label names only, to THIS terminal. Never written to a file.
 *
 * USAGE (from the repo root)
 *   dry run (default; read-only, REPEATABLE READ READ ONLY):
 *     railway run --service postgres node apps/api/scripts/labels-from-categories.mjs --tenant <tenantId>
 *     DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/labels-from-categories.mjs --local --tenant <tenantId>
 *   write (the owner, after reading the dry run):
 *     … --tenant <tenantId> --live --backup-taken --expect-rows <n from the dry run>
 *     a LIVE (non-test) tenant also needs --live-tenant-override and the typed phrase the run prints;
 *     a PROTECTED (paying / Stripe-linked / listed) tenant also needs --allow-protected <tenantId> and its
 *     own typed confirmation (live-target-guard).
 *   --tenant-slug <slug> is accepted as INPUT instead of --tenant; the slug is never printed.
 *   Needs the compiled API (`npm run build -w apps/api`): the single writer is loaded from apps/api/dist.
 *
 * EXIT: 0 done · 1 refused (a guard, a mismatch, nothing written) · 2 environment problem · 3 expect-rows
 * mismatch (nothing written).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { protectedArm } = require("./lib/paying-tenant.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const {
  assertWritableTenant,
  confirmProtectedOverride,
  hasBackupAttestation,
  refuseRetiredFlags,
  ProtectedTenantError,
} = require("./lib/live-target-guard.cjs");

const TAG = "labels-from-categories";
const HERE = dirname(fileURLToPath(import.meta.url));
const STATEMENT_TIMEOUT = "60s";
const LOCK_TIMEOUT = "5s";
const WRITE_TX_TIMEOUT_MS = 15 * 60_000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

// ─── the single writer (compiled) ─────────────────────────────────────────────

/**
 * The compiled `label-writer.js`. `LABELS_WRITER_MODULE` is a TEST-ONLY override (the DB spec compiles the
 * one file into a temp dir): honoured only inside a Jest worker, loudly; ignored anywhere else.
 */
export function writerPath(env = process.env) {
  if (env.LABELS_WRITER_MODULE) {
    if (env.JEST_WORKER_ID) {
      console.error(`${TAG}: WARNING test-only LABELS_WRITER_MODULE in use`);
      return env.LABELS_WRITER_MODULE;
    }
    console.error(`${TAG}: ignoring LABELS_WRITER_MODULE outside a Jest worker`);
  }
  return join(HERE, "..", "dist", "product-categories", "label-writer.js");
}

function loadWriter() {
  const p = writerPath();
  try {
    return require(p);
  } catch (e) {
    throw new Error(
      `cannot load the compiled label writer (${p}). Run \`npm run build -w apps/api\` first (${e.message})`,
    );
  }
}

// ─── pure: the plan ───────────────────────────────────────────────────────────

/** Code-point order: deterministic, and a capitalised form ("Frozen Foods") sorts before "frozen foods". */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group product texts into labels. `products`: [{ id, category }]. `existing`: the tenant's labels
 * [{ id, name, archivedAt }]. `memberships`: [{ productId, categoryId, mode }]. `keyOf` / `textOf`: the
 * writer's normalisers. Returns the plan (labels to create, memberships to add) plus the listed exceptions.
 */
export function planLabels({ products, existing, memberships, keyOf, textOf }) {
  const groups = new Map(); // key -> { texts: Map<text, count>, productIds: [] }
  let blank = 0;
  for (const p of products) {
    const key = keyOf(p.category);
    if (key === "") {
      blank++;
      continue;
    }
    const g = groups.get(key) ?? { texts: new Map(), productIds: [] };
    const t = textOf(p.category);
    g.texts.set(t, (g.texts.get(t) ?? 0) + 1);
    g.productIds.push(p.id);
    groups.set(key, g);
  }
  const byKey = new Map();
  for (const l of existing) {
    const k = keyOf(l.name);
    byKey.set(k, [...(byKey.get(k) ?? []), l]);
  }
  const has = new Map(memberships.map((m) => [`${m.productId}:${m.categoryId}`, m.mode]));

  const labels = []; // { key, name, existingId|null, products: n, add: [productId] }
  const merged = []; // { name, variants: [text] }
  const archived = []; // { name, products }
  const ambiguous = []; // { name, products }
  let alreadyIn = 0;
  let optedOut = 0;
  for (const [key, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = [...g.texts.entries()].sort(
      (a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]),
    )[0][0];
    if (g.texts.size > 1) merged.push({ name, variants: [...g.texts.keys()].sort() });
    // `existing` arrives oldest first (createdAt, id): case duplicates are never merged; like the sync, the
    // OLDEST unarchived one is used and the ambiguity is LISTED.
    const found = byKey.get(key) ?? [];
    const live = found.filter((l) => !l.archivedAt);
    if (found.length > 1) {
      ambiguous.push({
        name,
        products: g.productIds.length,
        labels: found.length,
        using: live[0]?.name ?? null,
      });
    }
    if (found.length > 0 && live.length === 0) {
      archived.push({ name: found[0].name, products: g.productIds.length });
      continue;
    }
    const existingId = live[0]?.id ?? null;
    const add = [];
    for (const productId of g.productIds) {
      const mode = existingId ? has.get(`${productId}:${existingId}`) : undefined;
      if (mode === "INCLUDE") alreadyIn++;
      else if (mode === "EXCLUDE") optedOut++;
      else add.push(productId);
    }
    labels.push({
      key,
      name: live[0]?.name ?? name,
      existingId,
      products: g.productIds.length,
      add,
    });
  }
  const create = labels.filter((l) => !l.existingId && l.add.length > 0);
  const addCount = labels.reduce((n, l) => n + l.add.length, 0);
  return {
    labels,
    create,
    addCount,
    rows: create.length + addCount,
    counts: {
      productsWithText: products.length - blank,
      blank,
      labels: labels.length,
      newLabels: create.length,
      reusedLabels: labels.filter((l) => l.existingId).length,
      memberships: addCount,
      alreadyIn,
      optedOut,
    },
    merged,
    archived,
    ambiguous,
  };
}

/** The typed confirmation for a live tenant: it carries the counts, so it can't be copied from another run. */
export const confirmPhrase = (plan, tenantId) =>
  `LABEL ${plan.addCount} PRODUCTS WITH ${plan.create.length} NEW LABELS FOR ${tenantId}`;

/** What users see change once labels exist (pre-live census, owner ruling): printed with every dry run. */
export const SURFACES = [
  "staff/admin, at once: Settings > Product categories lists the labels with product counts;",
  "  each product page's Labels card shows its label; the rule form and 'Limit in portal' list them.",
  "buyers, drivers, reports, exports, imports: NO change until a selling-restriction RULE targets a label.",
  "once a rule targets a label: buyer portal hides the labelled products (catalog, counts, detail, scan,",
  "  favorites, dashboard rails, shelf, stock alerts) and order/estimate/invoice/standing/recurring writes",
  "  can be refused (409); staff suggestions drop them; imports flag them.",
];

// ─── DB ───────────────────────────────────────────────────────────────────────

async function readState(db, tenantId) {
  const products = await db.product.findMany({
    where: { tenantId, category: { not: null } },
    select: { id: true, category: true },
    orderBy: { id: "asc" },
  });
  const existing = await db.productCategory.findMany({
    where: { tenantId },
    select: { id: true, name: true, archivedAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // oldest first: the deterministic pick among case duplicates
  });
  const memberships = await db.productCategoryLabel.findMany({
    where: { tenantId },
    select: { productId: true, categoryId: true, mode: true },
  });
  return { products, existing, memberships };
}

async function tenantRow(db, tenantId) {
  const t = await db.tenant.findFirst({
    where: { id: tenantId },
    select: {
      id: true,
      slug: true,
      status: true,
      class: true,
      deletedAt: true,
      subscription: { select: { planKey: true, stripeSubId: true, couponFull: true } },
    },
  });
  if (!t) throw refuse("no such tenant");
  return t;
}

/** paying-tenant's inputs: no plan = never paying (couponFull moot); else couponFull RAW (unselected throws). */
const subOf = (s) =>
  s
    ? {
        planKey: s.planKey,
        stripeSubId: s.stripeSubId,
        couponFull: s.planKey == null ? false : s.couponFull,
      }
    : null;

function report(plan) {
  const c = plan.counts;
  console.log(`\n${TAG}: products with category text: ${c.productsWithText} (blank: ${c.blank})`);
  console.log(`  labels: ${c.labels} (new: ${c.newLabels}, reusing existing: ${c.reusedLabels})`);
  console.log(
    `  memberships to add: ${c.memberships} (already labelled: ${c.alreadyIn}, opted out, left as is: ${c.optedOut})`,
  );
  console.log(`  rows to write: ${plan.rows}  (pass --expect-rows ${plan.rows} with --live)`);
  console.log("\n  label (products, to add):");
  for (const l of plan.labels)
    console.log(`    ${l.existingId ? "=" : "+"} ${l.name} (${l.products}, ${l.add.length})`);
  if (plan.merged.length) {
    console.log("\n  case variants merged into one label:");
    for (const m of plan.merged) console.log(`    ${m.name} <- ${m.variants.join(" | ")}`);
  }
  if (plan.archived.length) {
    console.log("\n  matches an ARCHIVED label, skipped (restore it first to use it):");
    for (const a of plan.archived) console.log(`    ${a.name} (${a.products})`);
  }
  if (plan.ambiguous.length) {
    console.log("\n  existing labels that share one name (never merged; the oldest is used):");
    for (const a of plan.ambiguous)
      console.log(
        `    ${a.name} (${a.products}): ${a.labels} labels, using ${a.using ?? "none (all archived)"}`,
      );
  }
  console.log("\n  what users will see change:");
  for (const s of SURFACES) console.log(`    ${s}`);
}

function target() {
  const local = has("--local");
  const url = local
    ? process.env.DATABASE_URL
    : resolveDatabaseUrl(process.env, { requireProxy: true });
  if (!url) throw new Error("--local requires DATABASE_URL");
  if (local && !isLocalDbTarget(url))
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  return url;
}

function clientFor(url) {
  const pool = new pg.Pool(has("--local") ? requireLocalPgConfig(url) : { connectionString: url });
  return { pool, prisma: new PrismaClient({ adapter: new PrismaPg(pool) }) };
}

async function resolveTenantId(prisma) {
  const id = argOf("--tenant");
  const slug = argOf("--tenant-slug");
  if (!!id === !!slug)
    throw refuse("pass exactly one of --tenant <tenantId> or --tenant-slug <slug>");
  if (id) return id;
  const t = await prisma.tenant.findFirst({ where: { slug }, select: { id: true } });
  if (!t) throw refuse("no tenant with that slug");
  return t.id; // the slug itself is never printed
}

function readlineAsk(question) {
  const rl = require("node:readline").createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

async function main() {
  refuseRetiredFlags(argv);
  const live = has("--live");
  let url;
  let protectedSlugs;
  try {
    url = target();
    protectedSlugs = loadProtectedSlugs(process.env, url);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
  let writer;
  try {
    writer = loadWriter();
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
  const { pool, prisma } = clientFor(url);
  console.log(`${TAG}: target ${redactUrl(url)} ${live ? "LIVE" : "DRY-RUN"}`);
  try {
    const tenantId = await resolveTenantId(prisma);
    const t = await tenantRow(prisma, tenantId);
    const arm = protectedArm(
      { slug: t.slug, status: t.status, class: t.class, deletedAt: t.deletedAt },
      subOf(t.subscription),
      protectedSlugs,
    );
    const test = isTestTenant(t.slug);
    console.log(
      `${TAG}: tenant ${tenantId} (${test ? "test" : "LIVE"}${arm ? `, protected: ${arm}` : ""})`,
    );

    // Dry run: one read-only snapshot.
    const plan = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        return planLabels({
          ...(await readState(tx, tenantId)),
          keyOf: writer.labelNameKey,
          textOf: writer.labelText,
        });
      },
      { isolationLevel: "RepeatableRead" },
    );
    report(plan);
    if (!live) return 0;

    // ── --live gates (all before the write transaction opens) ──
    if (!hasBackupAttestation(argv, "--backup-taken")) throw refuse("--live needs --backup-taken");
    const expect = Number(argOf("--expect-rows"));
    if (!Number.isInteger(expect)) throw refuse("--live needs --expect-rows <n> from your dry run");
    let override;
    if (arm)
      override = await confirmProtectedOverride({ tenantId, argv, backupFlag: "--backup-taken" });
    assertWritableTenant(
      { id: t.id, slug: t.slug, status: t.status, class: t.class, deletedAt: t.deletedAt },
      subOf(t.subscription),
      protectedSlugs,
      { allowProtected: override },
    );
    if (!test) {
      if (!has("--live-tenant-override"))
        throw refuse("a LIVE tenant needs --live-tenant-override");
      if (!(process.stdin.isTTY && process.stdout.isTTY))
        throw refuse("a LIVE tenant's confirmation needs a real terminal (stdin and stdout)");
      const phrase = confirmPhrase(plan, tenantId);
      const typed = await readlineAsk(`Type "${phrase}" to continue: `);
      if (String(typed).trim() !== phrase) throw refuse("the typed confirmation did not match");
    }

    // ── the write: ONE transaction, the plan RE-DERIVED under a per-tenant lock ──
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        // The per-tenant label-NAMES lock the admin create/rename also take (one shared key, label-writer).
        await writer.lockTenantLabelNames(tx, tenantId);
        const now = planLabels({
          ...(await readState(tx, tenantId)),
          keyOf: writer.labelNameKey,
          textOf: writer.labelText,
        });
        if (now.rows !== expect) {
          throw Object.assign(
            refuse(`--expect-rows ${expect} but this run would write ${now.rows}`),
            { code: 3 },
          );
        }
        const stamp = { createdById: null, createdByName: TAG };
        let labelsCreated = 0;
        const outcomes = { added: 0, present: 0, "opted-out": 0, archived: 0, missing: 0 };
        for (const l of now.labels) {
          if (l.add.length === 0) continue;
          let categoryId = l.existingId;
          if (!categoryId) {
            categoryId = (
              await tx.productCategory.create({
                data: { tenantId, name: l.name },
                select: { id: true },
              })
            ).id;
            labelsCreated++;
          }
          for (const productId of [...l.add].sort()) {
            const o = await writer.addIncludeIfAbsent(tx, {
              tenantId,
              productId,
              categoryId,
              stamp,
            });
            outcomes[o]++;
          }
        }
        if (outcomes.added !== now.addCount || labelsCreated !== now.create.length) {
          throw refuse(
            `wrote ${labelsCreated} labels / ${outcomes.added} memberships, planned ${now.create.length} / ${now.addCount}`,
          );
        }
        await tx.auditLog.create({
          data: {
            tenantId,
            userId: null,
            action: "product_label.backfill_from_category_text",
            entityType: "Tenant",
            entityId: tenantId,
            meta: { labelsCreated, membershipsAdded: outcomes.added },
          },
        });
        return { labelsCreated, added: outcomes.added };
      },
      { timeout: WRITE_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
    console.log(
      `${TAG}: committed — ${result.labelsCreated} label(s) created, ${result.added} membership(s) added`,
    );
    return 0;
  } catch (e) {
    if (e instanceof ProtectedTenantError) {
      console.error(`${TAG}: ${e.message} -- nothing was written`);
      return 1;
    }
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.code === 3 ? 3 : e.refuse ? 1 : 2;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => process.exit(code));
}
