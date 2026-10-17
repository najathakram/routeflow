import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Units U-6: the pre-connection gates of apps/api/scripts/backfill-tenant-units.mjs (SA M3). Spawns the
 * real script with NO database variables unless a case sets them; each case must be refused as an
 * argument or target decision, before any connection. The script's pure helpers are ESM, so they are
 * exercised in ONE `node --input-type=module` child (the convention of the other -script specs).
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/backfill-tenant-units.mjs");
const ID = "11111111-2222-4333-8444-555555555555";

function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === "DATABASE_URL" || k.startsWith("RAILWAY_") || k.startsWith("POSTGRES_"))
      delete env[k];
  }
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...env, ...extra },
    encoding: "utf8",
  });
}

function helpers(): Record<string, unknown> {
  const src = `
    import * as m from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
    const tryIt = (f) => { try { f(); return "ok"; } catch (e) { return e.message; } };
    const a = { liveOverride: false, backupTaken: false };
    console.log(JSON.stringify({
      testTenant: tryIt(() => m.assertLiveApplyAllowed(a, true)),
      liveBare: tryIt(() => m.assertLiveApplyAllowed(a, false)),
      liveOverrideOnly: tryIt(() => m.assertLiveApplyAllowed({ ...a, liveOverride: true }, false)),
      liveBoth: tryIt(() => m.assertLiveApplyAllowed({ liveOverride: true, backupTaken: true }, false)),
      subNoPlan: m.subOf({ planKey: null, stripeSubId: null, couponFull: undefined }),
      subPlanRaw: m.subOf({ planKey: "GROWTH", stripeSubId: "sub_1", couponFull: true }),
      applyDefault: m.parseArgs(["--tenant", ${JSON.stringify(ID)}]).apply,
      applyLocal: m.parseArgs(["--tenant", ${JSON.stringify(ID)}, "--local"]).apply,
      applyFlag: m.parseArgs(["--tenant", ${JSON.stringify(ID)}, "--apply"]).apply,
      backupAlias: m.parseArgs(["--tenant", ${JSON.stringify(ID)}, "--backup-taken"]).backupTaken,
      skips: m.parentSkipLines([{ reason: "b" }, { reason: "a" }, { reason: "b" }]),
      pieceRows: m.explicitPieceLines([{ label: "Case" }, { label: " Box " }, { label: "Case" }]),
      pieceNone: m.explicitPieceLines([]),
    }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("backfill-tenant-units.mjs gates (U-6, SA M3)", () => {
  it("requires --tenant, and takes the tenant id, never a slug", () => {
    expect(run([]).stderr).toContain("--tenant <tenantId> is required");
    const slug = run(["--tenant", "acme-wholesale", "--local"]);
    expect(slug.status).toBe(1);
    expect(slug.stderr).toContain("never a slug");
  });

  it("refuses the retired paying-tenant flags", () => {
    const r = run(["--tenant", ID, "--allow-paying-tenant"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("retired");
  });

  it("--local refuses a missing DATABASE_URL", () => {
    const r = run(["--tenant", ID, "--local"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--local requires DATABASE_URL");
  });

  it("--local refuses a non-local DATABASE_URL, including a ?host= redirect", () => {
    for (const url of [
      "postgresql://u:p@db.example.com:5432/db",
      "postgresql://u:p@localhost:5432/db?host=db.example.com",
      "postgresql://u:p@x.railway.internal:5432/db",
    ]) {
      const r = run(["--tenant", ID, "--local", "--apply"], { DATABASE_URL: url });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not provably local");
    }
  });

  it("without --local it needs the Railway proxy and never falls back to DATABASE_URL", () => {
    const r = run(["--tenant", ID], { DATABASE_URL: "postgresql://u:p@localhost:5432/db" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Missing Railway proxy variables");
  });

  describe("dry run is the default (SA-810 c)", () => {
    const h = helpers();
    const src = readFileSync(SCRIPT, "utf8");

    it("a write needs the explicit --apply flag: --tenant and --local alone never write", () => {
      expect(h.applyDefault).toBe(false);
      expect(h.applyLocal).toBe(false);
      expect(h.applyFlag).toBe(true);
    });

    it("the plan is applied only behind args.apply, after the live-target guards", () => {
      const call = src.indexOf("await applyTenantUnitsPlan(");
      expect(call).toBeGreaterThan(0);
      expect(src.match(/applyTenantUnitsPlan\(/g)).toHaveLength(1);
      const block = src.lastIndexOf("if (args.apply) {", call);
      expect(block).toBeGreaterThan(0);
      for (const guard of [
        "assertLiveApplyAllowed(args,",
        "confirmProtectedOverride(",
        "assertWritableTenant(",
      ]) {
        const at = src.indexOf(guard, block);
        expect(at).toBeGreaterThan(block);
        expect(at).toBeLessThan(call);
      }
    });

    it("reports the cap overflow in every run, dry or applied", () => {
      expect(src).toContain("overflowLines(plan.overflow");
    });
  });

  describe("pure helpers", () => {
    const h = helpers();

    it("a test tenant applies freely; a LIVE tenant needs --live-tenant-override AND --backup-taken", () => {
      expect(h.testTenant).toBe("ok");
      expect(h.liveBare).toContain("LIVE tenant");
      expect(h.liveOverrideOnly).toContain("LIVE tenant");
      expect(h.liveBoth).toBe("ok");
      expect(h.backupAlias).toBe(true);
    });

    it("subOf: no plan is never paying; with a plan couponFull passes RAW (unselected still throws)", () => {
      expect(h.subNoPlan).toEqual({ planKey: null, stripeSubId: null, couponFull: false });
      expect(h.subPlanRaw).toEqual({ planKey: "GROWTH", stripeSubId: "sub_1", couponFull: true });
    });

    it("levels on an explicit Piece row: one count line, then each level name with its count", () => {
      expect(h.pieceRows).toEqual(["parent is an explicit Piece row: 3", "  Box: 1", "  Case: 2"]);
      expect(h.pieceNone).toEqual([]);
    });

    it("parent skips are reported as counts per reason, never an id", () => {
      expect(h.skips).toEqual([
        "parent not filled for 1 level(s): a",
        "parent not filled for 2 level(s): b",
      ]);
    });
  });
});
