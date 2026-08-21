/**
 * demo-seed-images.js
 *
 * Uploads the staged product photos into the `routeflow-demo` catalog, after
 * demo-seed.js has created the products.
 *
 * Goes through the product's own audited API route (POST /products/:id/images)
 * rather than writing storage or the database directly, so the server-side
 * compression, key naming and imageKeys append are exactly what a UI upload
 * produces. Focal point is dead centre, matching the staged crops.
 *
 * A product's demo id is derived from its source id with the shared
 * lib/demo-ids.js hash, so no mapping file has to be carried between the two
 * scripts.
 *
 * Credentials come from the environment ONLY (never printed, never persisted):
 *   RF_DEMO_USERNAME / RF_DEMO_PASSWORD   default routeflow_demo / routeflow_demo
 *   RF_API_URL                            default the production API
 *
 * Re-runnable: one catalog listing up front skips every product that already has
 * an image, so an interrupted run resumes without duplicating uploads.
 *
 * Usage (from repo root):
 *   Dry run:  node apps/api/scripts/demo-seed-images.js
 *   Upload:   node apps/api/scripts/demo-seed-images.js --live
 *             node apps/api/scripts/demo-seed-images.js --live --limit 25
 */

const fs = require("fs");
const path = require("path");

const { assertTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { DEMO_SLUG, demoProductId } = require("./lib/demo-ids");

const TENANT_SLUG = assertTestTenant(DEMO_SLUG, "demo-seed-images");
const API = (
  process.env.RF_API_URL || "https://routeflowapi-production.up.railway.app/api/v1"
).replace(/\/$/, "");
const USERNAME = process.env.RF_DEMO_USERNAME || "routeflow_demo";
const PASSWORD = process.env.RF_DEMO_PASSWORD || "routeflow_demo";
const ASSETS_DIR = process.env.DEMO_ASSETS_DIR
  ? path.resolve(process.env.DEMO_ASSETS_DIR)
  : path.resolve(__dirname, "../../../.personal/img");

const LIVE = process.argv.includes("--live");
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i > -1 ? Number(process.argv[i + 1]) : Infinity;
})();
// The API throttle is 100 requests / 60s (ThrottlerModule in app.module.ts).
// One upload per product plus a single catalog listing keeps us at ~85/min.
const PACE_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, opts = {}, token, attempt = 0) {
  const res = await fetch(`${API}${pathname}`, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  // Back off on a throttle or transient server error. A multipart body is not
  // replayable, so those are left for the next run instead of retried here.
  if (
    (res.status === 429 || res.status >= 500) &&
    attempt < 4 &&
    !(opts.body instanceof FormData)
  ) {
    const wait = Math.min(60_000, 2000 * 2 ** attempt);
    console.log(`  · ${res.status} on ${pathname} — waiting ${wait / 1000}s`);
    await sleep(wait);
    return api(pathname, opts, token, attempt + 1);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail =
      typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200);
    throw new Error(`${res.status} ${pathname} — ${detail}`);
  }
  return body;
}

let tokenState = { token: null, issuedAt: 0 };

/** Sign in as the demo tenant's own admin — TENANT_ADMIN satisfies the OPERATOR guard. */
async function login() {
  if (tokenState.token && Date.now() - tokenState.issuedAt < 12 * 60_000) return tokenState.token;
  const res = await api("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tenant-Slug": TENANT_SLUG },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const token = res.accessToken || res.access_token;
  if (!token) throw new Error("login returned no accessToken");
  tokenState = { token, issuedAt: Date.now() };
  return token;
}

function loadStagedImages() {
  const manifestPath = path.join(ASSETS_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`\n❌ No manifest at ${manifestPath}. Set DEMO_ASSETS_DIR.\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return Object.entries(manifest.entries ?? {})
    .filter(([, e]) => e && e.uploaded === true && e.file && fs.existsSync(e.file))
    .map(([sourceId, e]) => ({
      sourceId,
      demoId: demoProductId(sourceId),
      file: e.file,
      mime: e.mime || "image/jpeg",
      name: e.productName || path.basename(e.file),
    }));
}

async function main() {
  console.log(`\n🖼  Demo catalog images — ${LIVE ? "LIVE UPLOAD" : "DRY RUN (no writes)"}`);
  console.log(`   API:     ${API}`);
  console.log(`   Tenant:  ${TENANT_SLUG}`);
  console.log(`   Assets:  ${ASSETS_DIR}`);

  const staged = loadStagedImages();
  console.log(`   Staged:  ${staged.length} vetted images on disk\n`);
  if (staged.length === 0) {
    console.error("❌ Nothing staged to upload.");
    process.exit(1);
  }

  const token = await login();
  // One fetch-all listing tells us which products already carry an image, so a
  // resumed run costs one request instead of one GET per product.
  const listing = await api("/products?limit=0", {}, token);
  const products = listing.data ?? listing;
  const byId = new Map(products.map((p) => [p.id, p]));
  console.log(`   Catalog: ${products.length} products in the demo tenant`);

  const missingFromCatalog = staged.filter((s) => !byId.has(s.demoId));
  const alreadyHaveImage = staged.filter((s) => (byId.get(s.demoId)?.imageKeys ?? []).length > 0);
  const pending = staged
    .filter((s) => byId.has(s.demoId) && (byId.get(s.demoId).imageKeys ?? []).length === 0)
    .slice(0, LIMIT === Infinity ? undefined : LIMIT);

  console.log(`   Already imaged: ${alreadyHaveImage.length}`);
  if (missingFromCatalog.length > 0) {
    console.log(
      `   ⚠ ${missingFromCatalog.length} staged image(s) have no matching demo product — run demo-seed.js first`,
    );
  }
  console.log(`   To upload:      ${pending.length}\n`);

  if (pending.length === 0) {
    console.log("✅ Nothing to do — every demo product with a staged photo already has one.\n");
    return;
  }
  if (!LIVE) {
    pending
      .slice(0, 10)
      .forEach((p) => console.log(`   ${p.name.slice(0, 46).padEnd(46)} ${path.basename(p.file)}`));
    if (pending.length > 10) console.log(`   … and ${pending.length - 10} more`);
    const minutes = Math.ceil((pending.length * PACE_MS) / 60000);
    console.log(`\n✅ Dry run complete — about ${minutes} min of uploads. Re-run with --live.\n`);
    return;
  }

  let ok = 0;
  let failed = 0;
  const failures = [];
  for (const item of pending) {
    try {
      const auth = await login();
      const form = new FormData();
      const buf = fs.readFileSync(item.file);
      form.append("files", new Blob([buf], { type: item.mime }), path.basename(item.file));
      // Dead centre: the staged crops are already square and subject-centred.
      form.append("focalX", "50");
      form.append("focalY", "50");
      await api(`/products/${item.demoId}/images`, { method: "POST", body: form }, auth);
      ok += 1;
      if (ok % 25 === 0) console.log(`   …${ok}/${pending.length} uploaded`);
    } catch (err) {
      failed += 1;
      failures.push(`${item.name}: ${err.message}`);
      if (failures.length <= 10) console.log(`   ! ${item.name}: ${err.message}`);
    }
    await sleep(PACE_MS);
  }

  console.log(`\n✅ Uploaded ${ok} | failed ${failed}`);
  if (failed > 0)
    console.log(`   Re-run to retry the failures — products that succeeded are skipped.\n`);
  else console.log("");
}

main().catch((e) => {
  console.error("\n❌ Image upload failed:", e?.message ?? e);
  process.exit(1);
});
