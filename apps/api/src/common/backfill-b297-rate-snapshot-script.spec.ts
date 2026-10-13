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
      categoryTaxRate: "0.05", // categoryTaxSnapshotOf normalises the rate; the write casts ::numeric
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

  it("a live tenant needs the override, the literal phrase, its own --yes-tenant AND the id typed back", () => {
    const out = runModule(`
      const g = (o) => m.liveTenantGate({ liveTenantIds: ["t-1", "t-2"], counts: { trio: 3, l2: 2 }, override: true, confirm: "APPLY TRIO 3 L2 2 LINES", yesTenants: ["t-1", "t-2"], typedTenants: ["t-1", "t-2"], ...o });
      console.log(JSON.stringify({
        ok: g({}),
        noOverride: g({ override: false }),
        badPhrase: g({ confirm: "APPLY TRIO 2 L2 3 LINES" }),
        oldPhrase: g({ confirm: "APPLY 5 LINES" }),
        missingYes: g({ yesTenants: ["t-1"] }),
        notTyped: g({ typedTenants: ["t-1"] }),
        noneTyped: g({ typedTenants: undefined }),
        noLive: m.liveTenantGate({ liveTenantIds: [], counts: { trio: 3, l2: 2 }, override: false, confirm: undefined, yesTenants: [] }),
      }));`);
    expect(out.ok).toEqual({ ok: true });
    expect(out.noOverride.ok).toBe(false);
    expect(out.badPhrase.ok).toBe(false);
    expect(out.oldPhrase.ok).toBe(false);
    expect(out.missingYes).toMatchObject({ ok: false });
    expect(out.missingYes.reason).toContain("t-2");
    expect(out.notTyped).toMatchObject({ ok: false });
    expect(out.notTyped.reason).toContain("t-2");
    expect(out.noneTyped.ok).toBe(false);
    expect(out.noLive).toEqual({ ok: true });
  });

  it("confirmLiveTenantYes: needs the flag naming the tenant, a real terminal, and the id typed back", () => {
    const out = runModule(`
      const tty = { isTTY: true };
      const notTty = { isTTY: false };
      const tries = async (o) => { try { return await m.confirmLiveTenantYes(o); } catch (e) { return e.refuse ? "REFUSED:" + e.message : "THROW:" + e.message; } };
      const typed = (id) => async () => id;
      console.log(JSON.stringify({
        ok: await tries({ tenantId: "t-1", argv: ["--yes-tenant", "t-1"], stdin: tty, stdout: tty, ask: typed("t-1") }),
        noFlag: await tries({ tenantId: "t-1", argv: [], stdin: tty, stdout: tty, ask: typed("t-1") }),
        otherFlag: await tries({ tenantId: "t-1", argv: ["--yes-tenant", "t-2"], stdin: tty, stdout: tty, ask: typed("t-1") }),
        noTtyIn: await tries({ tenantId: "t-1", argv: ["--yes-tenant", "t-1"], stdin: notTty, stdout: tty, ask: typed("t-1") }),
        noTtyOut: await tries({ tenantId: "t-1", argv: ["--yes-tenant", "t-1"], stdin: tty, stdout: notTty, ask: typed("t-1") }),
        wrongTyped: await tries({ tenantId: "t-1", argv: ["--yes-tenant", "t-1"], stdin: tty, stdout: tty, ask: typed("t-2") }),
        padded: await tries({ tenantId: "t-1", argv: ["--yes-tenant", "t-1"], stdin: tty, stdout: tty, ask: typed("  t-1 ") }),
      }));`);
    expect(out.ok).toBe("t-1");
    expect(out.noFlag).toMatch(/REFUSED:.*--yes-tenant must name/);
    expect(out.otherFlag).toMatch(/REFUSED:.*--yes-tenant must name/);
    expect(out.noTtyIn).toMatch(/REFUSED:.*real terminal/);
    expect(out.noTtyOut).toMatch(/REFUSED:.*real terminal/);
    expect(out.wrongTyped).toMatch(/REFUSED:.*did not match/);
    expect(out.padded).toBe("t-1");
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
    const updates = [...code.matchAll(/UPDATE "[^"]+" i SET([\s\S]*?)WHERE/g)].map((m) => m[1]);
    // ONE templated write (writeSqlFor), its table only ever from TABLES.
    expect(updates).toHaveLength(1);
    expect(code.match(/UPDATE "/g)).toHaveLength(1);
    // Every planned line must write exactly one row, or the whole apply refuses before COMMIT.
    expect(code).toMatch(/if \(written !== plan\.apply\.length\)/);
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

  it("the write re-states its proof: own tenant, the mode's column still NULL; the counts and category gates", () => {
    const out = runModule(`
      const trio = m.writeSqlFor("OrderItem", "TRIO");
      const l2 = m.writeSqlFor("InvoiceItem", "L2-INVOICE");
      const set = { categoryTaxType: "EXCISE_PER_UNIT", categoryTaxRate: "0.05", categoryPriceIncludesTax: false };
      let bad = null;
      try { m.writeSqlFor("Product", "TRIO"); } catch (e) { bad = e.message; }
      console.log(JSON.stringify({
        trio, l2, bad, trioNull: m.TRIO_NULL_SQL,
        counts: m.modeCounts([{ mode: "TRIO" }, { mode: "L2-ORDER" }, { mode: "L2-INVOICE" }, { mode: "TRIO" }]),
        phrase: m.confirmPhrase({ trio: 2, l2: 2 }),
        same: m.categoryMatchesPlan({ taxType: "EXCISE_PER_UNIT", rate: "0.0500", priceIncludesTax: false }, set),
        rate: m.categoryMatchesPlan({ taxType: "EXCISE_PER_UNIT", rate: "0.0700", priceIncludesTax: false }, set),
        type: m.categoryMatchesPlan({ taxType: "PERCENT_OF_SALE", rate: "0.0500", priceIncludesTax: false }, set),
        incl: m.categoryMatchesPlan({ taxType: "EXCISE_PER_UNIT", rate: "0.0500", priceIncludesTax: true }, set),
        gone: m.categoryMatchesPlan(undefined, set),
        hint: m.applyHint({ plan: { admittedProtectedTenantIds: ["t-9"], apply: [{ mode: "TRIO" }] } }, "/x/plan.json", "h".repeat(64)),
      }));`);
    // The TRIO guard IS the plan's partly-NULL predicate (R4), never a narrower one.
    expect(out.trio).toContain(`WHERE i.id = $1 AND ${out.trioNull}`);
    expect(out.trioNull).toBe(
      `(i."categoryTaxType" IS NULL OR i."categoryTaxRate" IS NULL OR i."categoryPriceIncludesTax" IS NULL)`,
    );
    expect(code).toContain("AND ${TRIO_NULL_SQL})");
    expect(out.trio).toMatch(/= \$6$/);
    expect(out.trio).toContain(`FROM "Order" p WHERE p.id = i."orderId"`);
    expect(out.l2).toMatch(/AND i\."trackedCategoryId" IS NULL/);
    expect(out.l2).toContain(`FROM "Invoice" p WHERE p.id = i."invoiceId"`);
    expect(out.bad).toMatch(/unknown table Product/);
    expect(out.counts).toEqual({ trio: 2, l2: 2 });
    expect(out.phrase).toBe("APPLY TRIO 2 L2 2 LINES");
    expect([out.same, out.rate, out.type, out.incl, out.gone]).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(out.hint).toMatch(
      /^to apply: railway run --service postgres node apps\/api\/scripts\/backfill-b297-rate-snapshot\.mjs --apply/,
    );
    expect(out.hint).toContain("--allow-protected t-9");
    expect(out.hint).toContain('--confirm "APPLY TRIO 1 L2 0 LINES"');
  });
  it("protection reads couponFull with the subscription: comped plan unprotected, unselected column throws", () => {
    const out = runModule(`
      const t = { id: "t-1", slug: "acme", status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
      const arm = (sub) => m.protectedTenants([{ ...t, ...sub }], new Set()).get("t-1") ?? null;
      let unselected = null;
      try { arm({ planKey: "STARTER", stripeSubId: null }); } catch (e) { unselected = e.message; }
      console.log(JSON.stringify({
        paying: arm({ planKey: "STARTER", stripeSubId: null, couponFull: false }),
        comped: arm({ planKey: "STARTER", stripeSubId: null, couponFull: true }),
        compedLinked: arm({ planKey: "STARTER", stripeSubId: "sub_x", couponFull: true }),
        noPlan: arm({ planKey: null, stripeSubId: null, couponFull: null }),
        noSubRow: arm({ planKey: null, stripeSubId: null }),
        unselected,
      }));`);
    expect(out.paying).toBe("paying");
    expect(out.comped).toBeNull();
    expect(out.compedLinked).toBe("stripe-linked");
    expect(out.noPlan).toBeNull();
    expect(out.noSubRow).toBeNull();
    expect(out.unselected).toMatch(/couponFull must be a boolean/);
    expect(code).toMatch(/s\."stripeSubId", s\."couponFull"\s+FROM "Tenant" t/);
  });
});
