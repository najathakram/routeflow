/**
 * The pure part of report-b1103-included-addons-priced.mjs (B1103 / SA-1104 Q4): judge, count, format, exit code.
 * CommonJS so the Jest spec drives it in-process with the REAL I3 predicate and `inclusionOf` from source (no dist
 * needed in CI), while the script injects the same two from the compiled `apps/api/dist`: one predicate, never a copy.
 * No database, no I/O.
 */
const { isTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SCRIPT = "report-b1103-included-addons-priced";

const UPPER_BOUND_NOTE = "upper bound: what the row says is owed, not what was invoiced or charged";
const NO_ITEM_NOTE = "not charged at Stripe; manual-invoice and MRR exposure only";

/** Whole months from `from` to `to` (calendar months, a partial month does not count), never below 0. */
function wholeMonths(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const usd = (n) => `$${round2(n).toFixed(2)}`;

/**
 * Judge every tenant. Pure given the loaded dist code (`d`) and the rows read:
 * `tenants` `{ id, slug, plan, planVersionId, sub: {planKey, planVersionId, stripeSubId, externalPayment, couponFull}|null }`,
 * `rowsByTenant` Map of addon rows, `skusByVersion` Map of versionId to AddonSku rows, `knownVersions` Set of version
 * ids that exist, `publishedId` the published version id (or null), `since` Map rowId to the Date of the row's last
 * price change, `now` a Date. Returns `{ rows: [{ tenantId, slug, kind, ... }], unjudged: [...] }`.
 */
function judge({
  d,
  tenants,
  rowsByTenant,
  skusByVersion,
  knownVersions,
  publishedId,
  since,
  now,
}) {
  const versionOf = (t) => {
    const id = t.sub?.planVersionId ?? t.planVersionId ?? null;
    return id && knownVersions.has(id) ? id : publishedId;
  };
  const planKeyOf = (t) =>
    d.normalizePlanKey(t.sub?.planKey) ?? (t.plan ? d.planKeyFromEnum(t.plan) : null);
  const invTenants = tenants.map((t) => ({
    id: t.id,
    slug: t.slug,
    name: null,
    status: "ACTIVE",
    plan: t.plan,
    planVersionId: t.planVersionId,
    subscription: t.sub,
  }));
  const bySlug = new Map(tenants.map((t) => [t.id, t.slug]));
  const ctx = {
    now,
    windowStart: now,
    tenants: invTenants,
    rowsOf: (id) => rowsByTenant.get(id) ?? [],
    latestActorKind: () => undefined,
    lastBusinessChange: () => undefined,
    skusOf: (it) => {
      const t = tenants.find((x) => x.id === it.id);
      const v = t ? versionOf(t) : null;
      return v ? (skusByVersion.get(v) ?? null) : null;
    },
    planKeyOf: (it) => planKeyOf(tenants.find((x) => x.id === it.id)),
    modeOf: () => "UNBILLED",
  };
  const findings = d.i3.run(ctx);
  const rowById = new Map();
  for (const rows of rowsByTenant.values()) for (const r of rows) rowById.set(r.id, r);
  const out = findings.map((f) => {
    const r = rowById.get(f.rowId);
    const price = Number(r.priceSnapshot ?? 0);
    const months = wholeMonths(since.get(r.id) ?? r.createdAt, now);
    return {
      tenantId: f.tenantId,
      slug: bySlug.get(f.tenantId),
      rowId: f.rowId,
      sku: f.sku,
      kind: r.stripeItemId ? "STRIPE_ITEM" : "PRICED_NO_ITEM",
      price,
      quantity: Number(r.quantity ?? 1),
      since: new Date(since.get(r.id) ?? r.createdAt).toISOString().slice(0, 10),
      months,
      owed: round2(price * months),
    };
  });
  // Active, non-comp rows whose inclusion cannot be judged (an unparseable catalog value, or no catalog or plan for
  // the tenant): not proven clean, counted apart. No price test here: the finding predicate lives in the dist's I3 only.
  const found = new Set(out.map((o) => o.rowId));
  const unjudged = [];
  for (const t of tenants) {
    const plan = planKeyOf(t);
    const skus = ctx.skusOf({ id: t.id });
    for (const r of rowsByTenant.get(t.id) ?? []) {
      if (!r.active || r.isComp || found.has(r.id)) continue;
      if (!skus || !plan) {
        unjudged.push({ tenantId: t.id, slug: t.slug, rowId: r.id, why: "NO_CATALOG_OR_PLAN" });
        continue;
      }
      const code = d.addonSkuCode({ sku: r.sku, addonKey: r.addonKey }) ?? r.addonKey;
      const def = skus.find((s) => s.sku === code);
      if (def && d.inclusionOf(def, plan).kind === "CATALOG_INVALID") {
        unjudged.push({ tenantId: t.id, slug: t.slug, rowId: r.id, why: "CATALOG_INVALID" });
      }
    }
  }
  return { rows: out, unjudged };
}

const emptyKind = () => ({ rows: 0, tenants: 0, monthly: 0, owed: 0 });
const emptyBlock = () => ({
  tenants: 0,
  findings: 0,
  kinds: { STRIPE_ITEM: emptyKind(), PRICED_NO_ITEM: emptyKind() },
  unjudged: { CATALOG_INVALID: 0, NO_CATALOG_OR_PLAN: 0 },
  items: [],
});

/**
 * Counts per block (LIVE tenants, TEST tenants). The slug is used only to pick the block; it, and every Stripe id,
 * never leave this function.
 */
function buildReport({ tenants, judged }) {
  const report = { live: emptyBlock(), test: emptyBlock() };
  const blockOf = (slug) => (isTestTenant(slug) ? report.test : report.live);
  for (const t of tenants) blockOf(t.slug).tenants += 1;
  const tenantsSeen = new Map();
  for (const r of judged.rows) {
    const b = blockOf(r.slug);
    b.findings += 1;
    const k = b.kinds[r.kind];
    k.rows += 1;
    k.monthly = round2(k.monthly + r.price);
    k.owed = round2(k.owed + r.owed);
    const key = `${r.tenantId}|${r.kind}`;
    if (!tenantsSeen.has(key)) {
      tenantsSeen.set(key, true);
      k.tenants += 1;
    }
    b.items.push({
      tenantId: r.tenantId,
      rowId: r.rowId,
      sku: r.sku,
      kind: r.kind,
      price: r.price,
      quantity: r.quantity,
      since: r.since,
      months: r.months,
      owed: r.owed,
    });
  }
  for (const u of judged.unjudged) blockOf(u.slug).unjudged[u.why] += 1;
  return report;
}

/** The report as printed lines (pure): both blocks, the labels, then the line the owner reads. */
function formatReport(report) {
  const lines = [];
  for (const [name, b] of Object.entries(report)) {
    lines.push(`${name.toUpperCase()}: ${b.tenants} tenant(s) read, ${b.findings} finding row(s)`);
    const s = b.kinds.STRIPE_ITEM;
    const p = b.kinds.PRICED_NO_ITEM;
    lines.push(
      `  STRIPE_ITEM: ${s.rows} row(s) in ${s.tenants} tenant(s), ${usd(s.monthly)} a month on the rows, ${usd(s.owed)} since (${UPPER_BOUND_NOTE}; the Stripe item's own price is not read)`,
    );
    lines.push(
      `  PRICED_NO_ITEM: ${p.rows} row(s) in ${p.tenants} tenant(s), ${usd(p.monthly)} a month on the rows, ${usd(p.owed)} since (${UPPER_BOUND_NOTE}; ${NO_ITEM_NOTE})`,
    );
    const u = b.unjudged;
    if (u.CATALOG_INVALID || u.NO_CATALOG_OR_PLAN)
      lines.push(
        `  UNJUDGED active non-comp row(s), inclusion could not be judged (not proven clean, not findings): catalog invalid ${u.CATALOG_INVALID}, no catalog or plan ${u.NO_CATALOG_OR_PLAN}`,
      );
    for (const i of b.items)
      lines.push(
        `  tenant ${i.tenantId} row ${i.rowId} ${i.sku} ${i.kind}: ${usd(i.price)} x ${i.months} month(s) since ${i.since} = ${usd(i.owed)} (${UPPER_BOUND_NOTE})`,
      );
  }
  lines.push(
    `LIVE FINDINGS: ${report.live.findings} (the exit code is 3 when this is above 0; TEST findings and unjudged rows are printed but never change it)`,
  );
  return lines;
}

/** 0 when LIVE is clean, 3 on any LIVE finding of either kind. TEST never changes the exit. */
const exitCodeFor = (report) => (report.live.findings > 0 ? 3 : 0);

/** No-DB, no-dist checks of the pure part (`--self-test`). Throws on the first failure. */
function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(
    [
      wholeMonths("2026-09-10", "2026-11-05"),
      wholeMonths("2026-09-10", "2026-11-10"),
      wholeMonths("2026-11-10", "2026-11-05"),
    ],
    [1, 2, 0],
    "wholeMonths",
  );
  const mk = (slug, kind, price, months) => ({
    tenantId: slug === "acme" ? "t-1" : "t-2",
    slug,
    rowId: `r-${slug === "acme" ? 1 : 2}-${kind}`,
    sku: "FORECASTING",
    kind,
    price,
    quantity: 1,
    since: "2026-09-10",
    months,
    owed: round2(price * months),
  });
  const rep = buildReport({
    tenants: [{ slug: "acme" }, { slug: "qa-x" }],
    judged: {
      rows: [
        mk("acme", "STRIPE_ITEM", 25, 2),
        mk("acme", "PRICED_NO_ITEM", 25, 1),
        mk("qa-x", "STRIPE_ITEM", 25, 1),
      ],
      unjudged: [{ tenantId: "t-1", slug: "acme", rowId: "r", why: "CATALOG_INVALID" }],
    },
  });
  eq(
    [rep.live.findings, rep.live.kinds.STRIPE_ITEM.owed, rep.live.kinds.PRICED_NO_ITEM.owed],
    [2, 50, 25],
    "live sums",
  );
  eq([rep.test.findings, rep.live.unjudged.CATALOG_INVALID], [1, 1], "test split, unjudged apart");
  eq(
    [
      exitCodeFor(rep),
      exitCodeFor({ live: { findings: 0 }, test: { findings: 4 } }),
      exitCodeFor({ live: { findings: 1 }, test: { findings: 0 } }),
    ],
    [3, 0, 3],
    "exit",
  );
  const text = formatReport(rep).join("\n");
  if (!text.includes(UPPER_BOUND_NOTE) || !text.includes(NO_ITEM_NOTE))
    throw new Error("the labels are missing");
  if (/acme|qa-x/.test(JSON.stringify(rep))) throw new Error("report leaked a slug");
  eq(formatReport(rep).pop().startsWith("LIVE FINDINGS: 2 "), true, "live findings line");
  return "self-test ok";
}

module.exports = {
  UPPER_BOUND_NOTE,
  NO_ITEM_NOTE,
  wholeMonths,
  judge,
  buildReport,
  formatReport,
  exitCodeFor,
  selfTest,
};
