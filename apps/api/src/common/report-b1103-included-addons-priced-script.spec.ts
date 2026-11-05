import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADDON_INVARIANTS } from "../billing/addon-invariant.job";
import { inclusionOf } from "../billing/addon-inclusion";
import { addonSkuCode, normalizePlanKey, planKeyFromEnum } from "../billing/plan-catalog.constants";

// B1103 / SA-1104 (Q4): apps/api/scripts/report-b1103-included-addons-priced.mjs. Rows D-1..D-10 (the SA's R-1..R-9 plus
// the missing-dist row). The pure part lives in scripts/lib/b1103-included-addons-core.cjs; this spec drives it
// in-process with the REAL I3 predicate and `inclusionOf` from source (the script injects the same two from the
// compiled dist, so the report and the daily alert cannot disagree and no copy of the predicate exists).

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/report-b1103-included-addons-priced.mjs");
const CORE = path.resolve(API_DIR, "scripts/lib/b1103-included-addons-core.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require(CORE) as {
  UPPER_BOUND_NOTE: string;
  NO_ITEM_NOTE: string;
  wholeMonths(from: unknown, to: unknown): number;
  judge(a: Record<string, unknown>): {
    rows: Array<Record<string, unknown>>;
    unjudged: Array<Record<string, unknown>>;
  };
  buildReport(a: Record<string, unknown>): any;
  formatReport(r: unknown): string[];
  exitCodeFor(r: unknown): number;
  selfTest(): string;
};
const scriptSource = fs.readFileSync(SCRIPT, "utf8");
const coreSource = fs.readFileSync(CORE, "utf8");

const i3 = ADDON_INVARIANTS.find((c) => c.id === "I3")!;
const d = { i3, inclusionOf, normalizePlanKey, planKeyFromEnum, addonSkuCode };

const NOW = new Date("2026-11-05T12:00:00Z");
const PINNED = "v-pinned";
const forecasting = (over: Record<string, unknown> = {}) => ({
  planVersionId: PINNED,
  sku: "FORECASTING",
  name: "Forecasting",
  monthlyPrice: "25.00",
  includedAtPlan: "SCALE",
  ...over,
});
const row = (id: string, tenantId: string, over: Record<string, unknown> = {}) => ({
  id,
  tenantId,
  addonKey: "FORECASTING",
  sku: "FORECASTING",
  active: true,
  isComp: false,
  quantity: 1,
  priceSnapshot: "25.00",
  stripeItemId: null,
  createdAt: new Date("2026-08-05T00:00:00Z"),
  updatedAt: new Date("2026-08-05T00:00:00Z"),
  ...over,
});
const tenant = (id: string, slug: string, planKey = "SCALE") => ({
  id,
  slug,
  plan: null,
  planVersionId: null,
  sub: {
    planKey,
    planVersionId: PINNED,
    stripeSubId: "sub_x",
    externalPayment: false,
    couponFull: false,
  },
});

/** Run the judge and the counts over one fixture. */
function run(
  tenants: ReturnType<typeof tenant>[],
  rows: ReturnType<typeof row>[],
  skus: ReturnType<typeof forecasting>[] = [forecasting()],
  since = new Map<string, Date>(),
) {
  const rowsByTenant = new Map<string, ReturnType<typeof row>[]>();
  for (const r of rows) rowsByTenant.set(r.tenantId, [...(rowsByTenant.get(r.tenantId) ?? []), r]);
  const judged = core.judge({
    d,
    tenants,
    rowsByTenant,
    skusByVersion: new Map([[PINNED, skus]]),
    knownVersions: new Set([PINNED]),
    publishedId: PINNED,
    since,
    now: NOW,
  });
  return { judged, report: core.buildReport({ tenants, judged }) };
}

describe("report-b1103-included-addons-priced.mjs", () => {
  it("exists, loads the I3 predicate from the compiled app, and its --self-test runs when spawned by its real path", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    const r = spawnSync(process.execPath, [SCRIPT, "--self-test"], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("self-test ok");
    expect(r.status).toBe(0);
    expect(core.selfTest()).toBe("self-test ok");
  });

  it("D-1: an active, non-comp row with a Stripe item on a plan that includes the SKU is a STRIPE_ITEM finding, owed price x months", () => {
    const { judged, report } = run(
      [tenant("t-1", "acme")],
      [row("r-1", "t-1", { stripeItemId: "si_1" })],
    );
    expect(judged.rows).toHaveLength(1);
    expect(judged.rows[0]).toMatchObject({
      kind: "STRIPE_ITEM",
      tenantId: "t-1",
      rowId: "r-1",
      sku: "FORECASTING",
      price: 25,
      months: 3,
      owed: 75,
    });
    expect(report.live.kinds.STRIPE_ITEM).toEqual({ rows: 1, tenants: 1, monthly: 25, owed: 75 });
    expect(core.exitCodeFor(report)).toBe(3);
  });

  it("D-2: a priced row with no Stripe item is PRICED_NO_ITEM, counted apart from STRIPE_ITEM", () => {
    const { report } = run(
      [tenant("t-1", "acme")],
      [row("r-1", "t-1"), row("r-2", "t-1", { addonKey: "X", sku: "X", stripeItemId: "si_2" })],
      [forecasting(), forecasting({ sku: "X" })],
    );
    expect(report.live.kinds.PRICED_NO_ITEM.rows).toBe(1);
    expect(report.live.kinds.STRIPE_ITEM.rows).toBe(1);
    expect(report.live.findings).toBe(2);
  });

  it("D-3: a comp row, an inactive row and a $0 row without an item are not findings", () => {
    const { judged, report } = run(
      [tenant("t-1", "acme")],
      [
        row("r-comp", "t-1", { isComp: true }),
        row("r-off", "t-1", { active: false }),
        row("r-zero", "t-1", { priceSnapshot: "0.00" }),
      ],
    );
    expect(judged.rows).toEqual([]);
    expect(core.exitCodeFor(report)).toBe(0);
  });

  it("D-4: a priced row on a plan that does NOT include the SKU is not this report's finding (that is I2's)", () => {
    const { judged } = run([tenant("t-1", "acme", "GROWTH")], [row("r-1", "t-1")]);
    expect(judged.rows).toEqual([]);
  });

  it("D-5: an unparseable includedAtPlan (CATALOG_INVALID) and a tenant with no catalog are counted APART, never a finding", () => {
    const invalid = run(
      [tenant("t-1", "acme")],
      [row("r-1", "t-1")],
      [forecasting({ includedAtPlan: "NOT_A_PLAN" })],
    );
    expect(invalid.judged.rows).toEqual([]);
    expect(invalid.report.live.unjudged).toEqual({ CATALOG_INVALID: 1, NO_CATALOG_OR_PLAN: 0 });
    expect(core.exitCodeFor(invalid.report)).toBe(0);
    expect(core.formatReport(invalid.report).join("\n")).toMatch(/UNJUDGED.*catalog invalid 1/);

    const rowsByTenant = new Map([["t-1", [row("r-1", "t-1")]]]);
    const noCatalog = core.judge({
      d,
      tenants: [tenant("t-1", "acme")],
      rowsByTenant,
      skusByVersion: new Map(),
      knownVersions: new Set(),
      publishedId: null,
      since: new Map(),
      now: NOW,
    });
    expect(noCatalog.rows).toEqual([]);
    expect(noCatalog.unjudged.map((u) => u.why)).toEqual(["NO_CATALOG_OR_PLAN"]);
  });

  it("D-6: LIVE and TEST are reported apart; a TEST finding never changes the exit, any LIVE finding exits 3", () => {
    const testOnly = run([tenant("t-1", "qa-run1")], [row("r-1", "t-1")]);
    expect(testOnly.report.test.findings).toBe(1);
    expect(testOnly.report.live.findings).toBe(0);
    expect(core.exitCodeFor(testOnly.report)).toBe(0);
    expect(core.formatReport(testOnly.report).pop()).toMatch(/^LIVE FINDINGS: 0 /);

    const both = run(
      [tenant("t-1", "qa-run1"), tenant("t-2", "acme")],
      [row("r-1", "t-1"), row("r-2", "t-2", { stripeItemId: "si_9" })],
    );
    expect(core.exitCodeFor(both.report)).toBe(3);
    expect(core.formatReport(both.report).pop()).toMatch(/^LIVE FINDINGS: 1 /);
    // ids only: no slug anywhere in the report or its printed form
    const blob = JSON.stringify(both.report) + core.formatReport(both.report).join("\n");
    expect(blob).not.toMatch(/acme|qa-run1|si_9|sub_x/);
  });

  it("D-7: the predicate is the invariant job's, never a copy (judge() finds exactly what I3 finds)", () => {
    const tenants = [tenant("t-1", "acme"), tenant("t-2", "globex", "GROWTH")];
    const rows = [
      row("a", "t-1"),
      row("b", "t-1", { stripeItemId: "si_1", priceSnapshot: "0.00" }),
      row("c", "t-1", { isComp: true }),
      row("d", "t-2"),
      row("e", "t-1", { active: false }),
      row("f", "t-1", { priceSnapshot: "0.00" }),
    ];
    const { judged } = run(tenants, rows);
    const rowsByTenant = new Map<string, typeof rows>();
    for (const r of rows)
      rowsByTenant.set(r.tenantId, [...(rowsByTenant.get(r.tenantId) ?? []), r]);
    const direct = i3.run({
      now: NOW,
      windowStart: NOW,
      tenants: tenants.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: null,
        status: "ACTIVE",
        plan: null,
        planVersionId: null,
        subscription: t.sub,
      })),
      rowsOf: (id: string) => (rowsByTenant.get(id) ?? []) as never,
      latestActorKind: () => undefined,
      lastBusinessChange: () => undefined,
      skusOf: () => [forecasting()] as never,
      planKeyOf: (t: { id: string }) => (t.id === "t-1" ? "SCALE" : "GROWTH"),
      modeOf: () => "UNBILLED",
    } as never);
    expect(judged.rows.map((r) => r.rowId).sort()).toEqual(direct.map((f) => f.rowId).sort());
    expect(judged.rows.map((r) => r.rowId).sort()).toEqual(["a", "b"]);
    // structural: the script gets I3 from the dist's registry, and neither file carries a price/item test of its own
    expect(scriptSource).toMatch(/ADDON_INVARIANTS\.find\(\(c\) => c\.id === "I3"\)/);
    const code = (src: string) =>
      src
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
    for (const src of [code(scriptSource), code(coreSource)]) {
      expect(src).not.toMatch(/priceSnapshot[^\n]*[<>]=?\s*0/);
      expect(src).not.toMatch(/stripeItemId\s*\|\||\|\|\s*\w+\.stripeItemId/);
    }
  });

  it("D-8: read-only: no write verb, the session is read-only with timeouts, and the guard spec lists it as read-only", () => {
    const code = (scriptSource + coreSource)
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT)\b\s/);
    expect(scriptSource).toContain("SET default_transaction_read_only = on");
    expect(scriptSource).toContain("SET statement_timeout");
    expect(scriptSource).toContain("SET lock_timeout");
    expect(scriptSource).toContain("finally");
    const guard = fs.readFileSync(
      path.resolve(__dirname, "scripts-live-target-guard.spec.ts"),
      "utf8",
    );
    expect(guard).toMatch(/report-b1103-included-addons-priced\.mjs":\s*"read-only"/);
  });

  it("D-9: months are whole calendar months since the row's last price change (else its creation); every sum carries the upper-bound label", () => {
    expect(core.wholeMonths("2026-09-10", "2026-11-05")).toBe(1);
    expect(core.wholeMonths("2026-09-10", "2026-11-10")).toBe(2);
    expect(core.wholeMonths("2026-11-10", "2026-11-05")).toBe(0);
    const { judged, report } = run(
      [tenant("t-1", "acme")],
      [row("r-1", "t-1"), row("r-2", "t-1", { addonKey: "X", sku: "X" })],
      [forecasting(), forecasting({ sku: "X" })],
      new Map([["r-1", new Date("2026-10-04T00:00:00Z")]]),
    );
    const byId = Object.fromEntries(judged.rows.map((r) => [r.rowId as string, r]));
    expect(byId["r-1"]).toMatchObject({ since: "2026-10-04", months: 1, owed: 25 });
    expect(byId["r-2"]).toMatchObject({ since: "2026-08-05", months: 3, owed: 75 });
    const text = core.formatReport(report).filter((l) => /\$\d/.test(l));
    expect(text.length).toBeGreaterThan(0);
    for (const line of text) expect(line).toContain(core.UPPER_BOUND_NOTE);
    expect(text.find((l) => l.includes("PRICED_NO_ITEM:"))).toContain(core.NO_ITEM_NOTE);
    expect(core.UPPER_BOUND_NOTE).toBe(
      "upper bound: what the row says is owed, not what was invoiced or charged",
    );
    expect(core.NO_ITEM_NOTE).toBe("not charged at Stripe; manual-invoice and MRR exposure only");
  });

  it("D-10: without apps/api/dist the script refuses to run: exit 2 and a sentence naming the build", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b1103-nodist-"));
    try {
      const put = (rel: string, from: string) => {
        const to = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      };
      put("apps/api/scripts/report-b1103-included-addons-priced.mjs", SCRIPT);
      put("apps/api/scripts/lib/b1103-included-addons-core.cjs", CORE);
      for (const f of ["report-db-url.mjs", "railway-db-url.mjs"])
        put(`apps/api/scripts/lib/${f}`, path.join(API_DIR, "scripts/lib", f));
      put(
        "scripts/lib/test-tenants.cjs",
        path.resolve(API_DIR, "../../scripts/lib/test-tenants.cjs"),
      );
      const r = spawnSync(
        process.execPath,
        [path.join(tmp, "apps/api/scripts/report-b1103-included-addons-priced.mjs")],
        { cwd: tmp, encoding: "utf8", timeout: 60_000, env: { ...process.env, DATABASE_URL: "" } },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("npm run build -w apps/api");
      expect(r.stderr).toMatch(/cannot find apps\/api\/dist/);
      expect(r.stdout).toBe("");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an unknown flag is a usage error (exit 2)", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--bogus"], {
      cwd: API_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(r.status).toBe(2);
  });
});
