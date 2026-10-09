import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * #2639 part C / SA-547 — the b294 backfill refuses to touch a PROTECTED tenant (paying, or linked to a
 * Stripe subscription) unless explicitly admitted:
 *   - dry run: a protected tenant's candidates are PAYING-HELD, never planned, unless --allow-paying-tenant;
 *   - apply: protection is RE-DERIVED in the transaction (the plan is never trusted); a tenant that turned
 *     protected since the dry run refuses the WHOLE apply; any protected tenant written needs
 *     --allow-paying-tenant AND --confirm-paying "APPLY TO PAYING <sorted slugs>";
 *   - the plan file and every log line carry tenant IDS and counts, never slugs.
 * Pure gates evaluated in a child node (the script is ESM); fixtures are qa-* slugs with a FAKE
 * stripeSubId. The executed dry-run/apply against a real database is F2's.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/backfill-b294-order-line-taxrate.mjs");
const HREF = pathToFileURL(SCRIPT).href;

const CASES = `
import * as b from "${HREF}";
const row = (id, slug, over = {}) => ({ id, slug, status: "ACTIVE", class: "PRODUCTION", deletedAt: null,
  planKey: "STARTER", stripeSubId: null, couponFull: false, ...over });
const prot = b.protectedTenants([
  row("t-paying", "qa-2639-paying"),
  row("t-stripe", "qa-2639-stripe", { class: "TEST", status: "READ_ONLY", planKey: null, stripeSubId: "sub_fake_qa" }),
  row("t-plain", "qa-2639-plain", { class: "TEST" }),
  row("t-deleted", "qa-2639-deleted", { class: "TEST", planKey: null, stripeSubId: "sub_fake_qa", deletedAt: "2026-01-01" }),
]);
const cands = ["t-paying", "t-stripe", "t-plain"].map((tenantId, i) => ({ invoiceId: "inv-" + i, tenantId }));
const now = (ids) => new Map(ids.map((id) => [id, { arm: "paying", slug: "qa-2639-" + id.slice(2) }]));
// Lead's Opus HIGH-1: the plan file the DRY RUN writes must verify at APPLY (it never did: \`held\` was
// written but hashed out and never stripped back). Built by the script's own functions, round-tripped
// through JSON exactly as the file is.
const plan = { generatedAt: "2026-09-28T00:00:00.000Z", fingerprint: { database: "rf_qa", tenantIds: ["t-plain"] },
  allowPayingTenant: false, admittedProtectedTenantIds: [], apply: [{ invoiceId: "inv-2", tenantId: "t-plain" }] };
// Tolerates the functions being ABSENT (the pre-fix tree), so a red fails on the round-trip assertion
// itself instead of crashing this whole child (which would mask every other pin).
const roundTrip =
  typeof b.planFileOf === "function" && typeof b.verifyPlanFile === "function"
    ? (() => {
        const file = JSON.parse(
          JSON.stringify(
            b.planFileOf(plan, [{ invoiceId: "inv-9" }], [{ invoiceId: "inv-0", tenantId: "t-paying" }]),
          ),
        );
        const tampered = { ...file, apply: [...file.apply, { invoiceId: "inv-x", tenantId: "t-paying" }] };
        return {
          verifies: JSON.stringify(b.verifyPlanFile(file, file.planHash)) === JSON.stringify(plan),
          heldEditedStillVerifies: b.verifyPlanFile({ ...file, held: [] }, file.planHash) !== null,
          tamperedApplyRefused: b.verifyPlanFile(tampered, file.planHash) === null,
          wrongConfirmRefused: b.verifyPlanFile(file, "0".repeat(64)) === null,
        };
      })()
    : { missing: "planFileOf / verifyPlanFile are not exported" };
console.log(JSON.stringify({
  roundTrip,
  prot: [...prot.entries()],
  noFlag: b.splitProtected(cands, prot, false),
  withFlag: b.splitProtected(cands, prot, true),
  gate: {
    unprotected: b.payingGate({ admittedProtectedTenantIds: [], nowProtected: new Map(), allowPayingTenant: false }),
    turnedProtected: b.payingGate({ admittedProtectedTenantIds: [], nowProtected: now(["t-plain"]), allowPayingTenant: true, confirmPaying: "APPLY TO PAYING qa-2639-plain" }),
    planFlagApplyNoFlag: b.payingGate({ admittedProtectedTenantIds: ["t-paying"], nowProtected: now(["t-paying"]), allowPayingTenant: false }),
    wrongPhrase: b.payingGate({ admittedProtectedTenantIds: ["t-paying"], nowProtected: now(["t-paying"]), allowPayingTenant: true, confirmPaying: "APPLY TO PAYING nope" }),
    rightPhrase: b.payingGate({ admittedProtectedTenantIds: ["t-paying", "t-stripe"], nowProtected: now(["t-stripe", "t-paying"]), allowPayingTenant: true, confirmPaying: "APPLY TO PAYING qa-2639-paying,qa-2639-stripe" }),
    turnedUnprotected: b.payingGate({ admittedProtectedTenantIds: ["t-paying"], nowProtected: new Map(), allowPayingTenant: false }),
  },
}));
`;

describe("#2639 part C — b294 holds and gates protected tenants (SA-547)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let r: any;
  beforeAll(() => {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", CASES], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(res.stderr).toBe("");
    r = JSON.parse(res.stdout.trim());
  });

  it("HIGH-1: the dry run's plan file verifies at apply (round trip); tampering the hashed body or the confirm refuses", () => {
    expect(r.roundTrip).toEqual({
      verifies: true,
      heldEditedStillVerifies: true,
      tamperedApplyRefused: true,
      wrongConfirmRefused: true,
    });
  });

  it("HIGH-1 source: the dry run writes planFileOf(...) and the apply verifies with verifyPlanFile — one shape", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const dry = src.slice(
      src.indexOf("async function dryRun()"),
      src.indexOf("async function apply()"),
    );
    const applyBody = src.slice(src.indexOf("async function apply()"));
    expect(dry).toMatch(/planFileOf\(plan, review, held\)/);
    expect(dry).toMatch(/writeFileSync\(file, JSON\.stringify\(planFile/);
    expect(applyBody).toMatch(/verifyPlanFile\(saved, confirmPlan\)/);
    expect(applyBody).not.toMatch(/sha256\(plan\)/);
  });

  it("paying and the Stripe arm alone (TEST, READ_ONLY, no planKey) are protected; plain and soft-deleted are not", () => {
    expect(Object.fromEntries(r.prot)).toEqual({
      "t-paying": "paying",
      "t-stripe": "stripe-linked",
    });
  });

  it("dry run without the flag: protected tenants' invoices are PAYING-HELD, never planned", () => {
    expect(r.noFlag.apply.map((a: any) => a.tenantId)).toEqual(["t-plain"]);
    expect(r.noFlag.held.map((h: any) => [h.tenantId, h.arm])).toEqual([
      ["t-paying", "paying"],
      ["t-stripe", "stripe-linked"],
    ]);
    expect(r.noFlag.admittedProtectedTenantIds).toEqual([]);
  });

  it("dry run with --allow-paying-tenant: planned, and the plan records which protected ids it admitted", () => {
    expect(r.withFlag.apply).toHaveLength(3);
    expect(r.withFlag.held).toEqual([]);
    expect(r.withFlag.admittedProtectedTenantIds).toEqual(["t-paying", "t-stripe"]);
  });

  it("apply: an unprotected plan passes; a tenant that TURNED protected refuses the whole apply, even with the flag", () => {
    expect(r.gate.unprotected).toEqual({ ok: true });
    expect(r.gate.turnedProtected.ok).toBe(false);
    expect(r.gate.turnedProtected.reason).toMatch(/became protected .* since the dry run/);
  });

  it("apply: a plan made WITH the flag, applied WITHOUT it, is refused (the apply never trusts the plan)", () => {
    expect(r.gate.planFlagApplyNoFlag.ok).toBe(false);
    expect(r.gate.planFlagApplyNoFlag.reason).toMatch(/--allow-paying-tenant/);
  });

  it("apply: flag + wrong phrase refused; flag + the sorted-slug phrase passes; one that turned UNprotected stays fine", () => {
    expect(r.gate.wrongPhrase.ok).toBe(false);
    expect(r.gate.rightPhrase).toEqual({ ok: true });
    expect(r.gate.turnedUnprotected).toEqual({ ok: true });
  });

  it("no refusal text names a slug — tenant ids only", () => {
    for (const g of Object.values(r.gate) as any[])
      if (g.reason) expect(g.reason).not.toMatch(/qa-2639-/);
  });

  it("source: the apply re-derives protection INSIDE its transaction, and the plan file and logs carry no slug", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const applyBody = src.slice(src.indexOf("async function apply()"));
    const begin = applyBody.indexOf('client.query("BEGIN")');
    const protRead = applyBody.indexOf("PROTECTION_SQL");
    const gate = applyBody.indexOf("payingGate(");
    expect(begin).toBeGreaterThan(-1);
    expect(protRead).toBeGreaterThan(begin);
    expect(gate).toBeGreaterThan(protRead);
    // The dry run's plan file payload and console lines never interpolate a slug.
    const dry = src.slice(
      src.indexOf("async function dryRun()"),
      src.indexOf("async function apply()"),
    );
    expect(dry).not.toMatch(/\bslug\b/);
  });
});
