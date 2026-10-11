import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

/**
 * B297 PR6 / SA-734r2 D3 + L2 + MED-2: the provable rate-snapshot backfill. The script is an ES module run by
 * node, so the pure functions run in a child process. Pinned here: the proof (a line is written ONLY when the
 * copied trio's recompute equals its stored amount), the L2 / MED-2 twin repair (agreement across every
 * contributing line, the effective state of a same-run repair), the live-tenant yes, the plan hash, and by
 * source: the only columns the UPDATE sets are the category + trio — never an amount.
 */
const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/backfill-b297-rate-snapshot.mjs");
const src = fs.readFileSync(SCRIPT, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

function runModule(body: string): any {
  const prog = `import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n${body}`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", prog], {
    encoding: "utf8",
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: "" },
  });
  expect(res.stderr).toBe("");
  expect(res.status).toBe(0);
  return JSON.parse(res.stdout);
}

const LINE = `{
  id: "o1", tenantId: "t-1", trackedCategoryId: "cat-1",
  categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null,
  qty: "12", boxes: null, pieces: null, unitsPerBox: null, unitLabel: null,
  subtotal: "100.00", categoryTaxAmount: "0.60", productUnitsPerBox: null, orderItemId: null,
  liveTaxType: "EXCISE_PER_UNIT", liveRate: "0.0500", livePriceIncludesTax: false, exempt: false,
}`;

describe("backfill-b297-rate-snapshot", () => {
  it("--self-test passes", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--self-test"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/self-test: all \d+ passed/);
  });

  it("TRIO writes only a line whose stored amount proves the category's current rate", () => {
    const out = runModule(`
      const L = ${LINE};
      console.log(JSON.stringify({
        proven: m.classifyTrio(L),
        moved: m.classifyTrio({ ...L, liveRate: "0.0700" }),
        percent: m.classifyTrio({ ...L, liveTaxType: "PERCENT_OF_SALE", liveRate: "0.0600", categoryTaxAmount: "6.00" }),
        boxed: m.classifyTrio({ ...L, qty: "24", boxes: 2, pieces: 0, unitsPerBox: 12, categoryTaxAmount: "1.20" }),
        packLine: m.classifyTrio({ ...L, qty: "2", unitsPerBox: null, productUnitsPerBox: 12, categoryTaxAmount: "1.20" }),
      }));`);
    expect(out.proven.kind).toBe("APPLY");
    expect(out.proven.set).toEqual({
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: "0.0500",
      categoryPriceIncludesTax: false,
    });
    expect(out.moved).toEqual({ kind: "LEFT", reason: "mismatch" });
    expect(out.percent.kind).toBe("APPLY");
    expect(out.boxed.kind).toBe("APPLY"); // 24 pieces x 0.05
    expect(out.packLine.kind).toBe("APPLY"); // 2 packs of 12 = 24 pieces x 0.05, the line's own basis
  });

  it("classifyPopulation: an order line repaired by TRIO proves its no-category twin from the effective state", async () => {
    const out = runModule(`
      const order = { ...${LINE}, id: "o-trio" }; // category set, NULL trio, 0.60 = 12 x 0.05: TRIO applies
      const twin = { ...${LINE}, id: "i-twin", trackedCategoryId: null, orderItemId: "o-trio", liveTaxType: null, liveRate: null };
      const r = await m.classifyPopulation({
        order: [order], invoice: [twin],
        invoiceSourcesFor: async () => [],
        orderSourcesFor: async () => [{ id: "o-trio", tenantId: "t-1", trackedCategoryId: "cat-1",
          categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null }],
      });
      console.log(JSON.stringify({ apply: r.candidates.map((c) => [c.table, c.id, c.mode]), left: r.left }));`);
    expect(out.apply).toEqual([
      ["OrderItem", "o-trio", "TRIO"],
      ["InvoiceItem", "i-twin", "L2-INVOICE"], // proven from the order line planned in THIS run
    ]);
    expect(out.left).toEqual([]);
  });

  it("an order line whose only invoice source is its no-category twin is LEFT (no circular repair)", async () => {
    const out = runModule(`
      const noCatOrder = { ...${LINE}, id: "o-nocat", trackedCategoryId: null, liveTaxType: null, liveRate: null };
      const twin = { id: "i-twin", orderItemId: "o-nocat", tenantId: "t-1", trackedCategoryId: null,
        categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null };
      const r = await m.classifyPopulation({
        order: [noCatOrder], invoice: [],
        invoiceSourcesFor: async () => [twin], orderSourcesFor: async () => [],
      });
      console.log(JSON.stringify({ apply: r.candidates.length, left: r.left.map((l) => l.reason) }));`);
    expect(out).toEqual({ apply: 0, left: ["no-category"] });
  });

  it("a line with no derivable tenant is never planned; a cross-tenant source or category is never copied; a zero basis proves nothing", () => {
    const out = runModule(`
      const noTenant = await m.classifyPopulation({
        order: [{ ...${LINE}, tenantId: null }], invoice: [],
        invoiceSourcesFor: async () => [], orderSourcesFor: async () => [],
      });
      const s = (o = {}) => ({ trackedCategoryId: "cat-1", categoryTaxType: "EXCISE_PER_UNIT", categoryTaxRate: "0.0500", categoryPriceIncludesTax: false, tenantId: "t-1", categoryTenantId: "t-1", ...o });
      const noCat = { ...${LINE}, trackedCategoryId: null };
      console.log(JSON.stringify({
        noTenant: { apply: noTenant.candidates.length, left: noTenant.left.map((l) => l.reason) },
        crossSource: m.classifyL2(noCat, [s({ tenantId: "t-2" })]),
        crossCategory: m.classifyL2(noCat, [s({ categoryTenantId: "t-2" })]),
        crossLive: m.classifyTrio({ ...${LINE}, categoryTenantId: "t-2" }),
        zeroBasis: m.classifyTrio({ ...${LINE}, qty: "0", subtotal: "0.00", categoryTaxAmount: "0.00" }),
        weak: m.classifyTrio(${LINE}).weak,
        strong: m.classifyTrio({ ...${LINE}, qty: "1200", subtotal: "1200.00", categoryTaxAmount: "60.00" }).weak,
      }));`);
    expect(out.noTenant).toEqual({ apply: 0, left: ["no-tenant"] });
    expect(out.crossSource).toEqual({ kind: "LEFT", reason: "cross-tenant" });
    expect(out.crossCategory).toEqual({ kind: "LEFT", reason: "cross-tenant" });
    expect(out.crossLive).toEqual({ kind: "LEFT", reason: "cross-tenant" });
    expect(out.zeroBasis).toEqual({ kind: "LEFT", reason: "zero-basis" });
    expect(out.weak).toBe(true); // 12 pieces: more than one 4-dp rate fits the cents
    expect(out.strong).toBe(false);
  });

  it("applyPlan proves every write from the locked row: a relabelled tenant, a VOID parent, a foreign category or a lost proof refuses", () => {
    const out = runModule(`
      const a = { table: "OrderItem", id: "o1", tenantId: "t-1",
        set: { trackedCategoryId: "cat-1", categoryTaxType: "EXCISE_PER_UNIT", categoryTaxRate: "0.0500", categoryPriceIncludesTax: false } };
      const row = (o = {}) => ({ tenantId: "t-1", parentStatus: "PENDING", qty: "12", boxes: null, pieces: null,
        unitsPerBox: null, unitLabel: null, subtotal: "100.00", categoryTaxAmount: "0.60", productUnitsPerBox: null, ...o });
      const tries = (fn) => { try { fn(); return "ok"; } catch (e) { return e.refuse ? e.message : "THROW:" + e.message; } };
      console.log(JSON.stringify({
        ok: tries(() => m.assertRowProvesWrite(row(), a, "t-1")),
        relabelled: tries(() => m.assertRowProvesWrite(row({ tenantId: "t-live" }), a, "t-live")),
        noTenant: tries(() => m.assertRowProvesWrite(row({ tenantId: null }), { ...a, tenantId: null }, "t-1")),
        void: tries(() => m.assertRowProvesWrite(row({ parentStatus: "VOID" }), { ...a, table: "InvoiceItem" }, "t-1")),
        foreignCategory: tries(() => m.assertRowProvesWrite(row(), a, "t-2")),
        lostProof: tries(() => m.assertRowProvesWrite(row({ categoryTaxAmount: "0.61" }), a, "t-1")),
      }));`);
    expect(out.ok).toBe("ok");
    expect(out.relabelled).toMatch(/no longer belongs to the planned tenant/);
    expect(out.noTenant).toMatch(/no longer belongs to the planned tenant/);
    expect(out.void).toMatch(/VOID invoice/);
    expect(out.foreignCategory).toMatch(/not the line's tenant's/);
    expect(out.lostProof).toMatch(/no longer proves/);
  });

  it("classifyL2 leaves and lists a line whose sources disagree, or whose copied trio does not reproduce the amount", () => {
    const out = runModule(`
      const noCat = { ...${LINE}, trackedCategoryId: null };
      const s = (o = {}) => ({ trackedCategoryId: "cat-1", categoryTaxType: "EXCISE_PER_UNIT", categoryTaxRate: "0.0500", categoryPriceIncludesTax: false, ...o });
      console.log(JSON.stringify({
        ok: m.classifyL2(noCat, [s(), s()]),
        disagree: m.classifyL2(noCat, [s(), s({ categoryTaxRate: "0.0800" })]),
        otherCategory: m.classifyL2(noCat, [s(), s({ trackedCategoryId: "cat-2" })]),
        wrong: m.classifyL2({ ...noCat, categoryTaxAmount: "9.99" }, [s()]),
        none: m.classifyL2(noCat, []),
        zero: m.classifyL2({ ...noCat, categoryTaxAmount: "0.00" }, [s()]),
      }));`);
    expect(out.ok.kind).toBe("APPLY");
    expect(out.disagree).toEqual({ kind: "LEFT", reason: "disagree" });
    expect(out.otherCategory).toEqual({ kind: "LEFT", reason: "disagree" });
    expect(out.wrong).toEqual({ kind: "LEFT", reason: "mismatch" });
    expect(out.none).toEqual({ kind: "LEFT", reason: "no-match" });
    expect(out.zero).toBeNull();
  });

  it("a live tenant needs the override, the literal phrase for the line count, and its own yes", () => {
    const out = runModule(`
      const g = (o) => m.liveTenantGate({ liveTenantIds: ["t-1", "t-2"], lineCount: 5, override: true, confirm: "APPLY 5 LINES", yesTenants: ["t-1", "t-2"], ...o });
      console.log(JSON.stringify({
        ok: g({}),
        noOverride: g({ override: false }),
        badPhrase: g({ confirm: "APPLY 4 LINES" }),
        missingYes: g({ yesTenants: ["t-1"] }),
        noLive: m.liveTenantGate({ liveTenantIds: [], lineCount: 5, override: false, confirm: undefined, yesTenants: [] }),
      }));`);
    expect(out.ok).toEqual({ ok: true });
    expect(out.noOverride.ok).toBe(false);
    expect(out.badPhrase.ok).toBe(false);
    expect(out.missingYes).toMatchObject({ ok: false });
    expect(out.missingYes.reason).toContain("t-2");
    expect(out.noLive).toEqual({ ok: true });
  });

  it("a protected tenant is held unless named; one that turned protected since the dry run refuses the apply", () => {
    const out = runModule(`
      const cands = [{ table: "OrderItem", id: "a", tenantId: "p" }, { table: "OrderItem", id: "b", tenantId: "q" }];
      const prot = new Map([["p", "paying"]]);
      const held = m.splitProtected(cands, prot, new Set());
      const admitted = m.splitProtected(cands, prot, new Set(["p"]));
      console.log(JSON.stringify({
        held: held.held.map((h) => h.id), applied: held.apply.map((a) => a.id),
        admitted: admitted.admittedProtectedTenantIds,
        turned: m.payingGate({ admittedProtectedTenantIds: [], nowProtected: new Map([["p", {}]]) }),
        same: m.payingGate({ admittedProtectedTenantIds: ["p"], nowProtected: new Map([["p", {}]]) }),
      }));`);
    expect(out.held).toEqual(["a"]);
    expect(out.applied).toEqual(["b"]);
    expect(out.admitted).toEqual(["p"]);
    expect(out.turned.ok).toBe(false);
    expect(out.same.ok).toBe(true);
  });

  it("the plan file hash covers the body only and verifies; a tampered body fails", () => {
    const out = runModule(`
      const plan = { generatedAt: "x", fingerprint: {}, admittedProtectedTenantIds: [], apply: [{ id: "a" }] };
      const file = m.planFileOf(plan, [{ id: "r" }], [{ id: "h" }]);
      console.log(JSON.stringify({
        ok: m.verifyPlanFile(file, file.planHash) !== null,
        tampered: m.verifyPlanFile({ ...file, apply: [{ id: "b" }] }, file.planHash),
        wrongHash: m.verifyPlanFile(file, "deadbeef"),
      }));`);
    expect(out.ok).toBe(true);
    expect(out.tampered).toBeNull();
    expect(out.wrongHash).toBeNull();
  });

  it("source: the only columns the UPDATEs set are the category and the trio — never an amount, qty or subtotal", () => {
    const updates = [
      ...code.matchAll(/UPDATE "(?:OrderItem|InvoiceItem)" SET([\s\S]*?)WHERE/g),
    ].map((m) => m[1]);
    expect(updates).toHaveLength(2);
    for (const set of updates) {
      const cols = [...set.matchAll(/"(\w+)" =/g)].map((m) => m[1]).sort();
      expect(cols).toEqual([
        "categoryPriceIncludesTax",
        "categoryTaxRate",
        "categoryTaxType",
        "trackedCategoryId",
      ]);
    }
    expect(code).not.toMatch(/\bDELETE\b|\bINSERT\b|\bDROP\b|\bTRUNCATE\b/i);
    expect(code).toMatch(/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
    expect(code).toMatch(/SET LOCAL lock_timeout/);
    expect(code).toMatch(/refuseRetiredFlags/);
    expect(code).toMatch(/assertWritableTenant/);
  });

  it("without a database the dry run exits 2 and writes nothing", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "--local"], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    expect(res.status).toBe(2);
  });
});
