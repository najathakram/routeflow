import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Close-out review (2026-09-05) — contract for the legacy NULL-`tenantId` repair tool:
 * `apps/api/scripts/backfill-legacy-tenant-ids.mjs` and its pure decision layer
 * `apps/api/scripts/lib/legacy-tenant-backfill.mjs`.
 *
 * No database is touched. Two techniques, both already house style here:
 *   - the pure module is ESM (`.mjs`) and this suite runs under ts-jest's CommonJS transform, so
 *     every classifier case is evaluated in ONE `node --input-type=module` child that imports
 *     the real module by `file://` URL and prints a JSON array — the same shim shape as
 *     `railway-db-url.spec.ts` (no ts-jest ESM loader, no duplicated logic to drift).
 *   - the CLI's argument refusal is exercised by spawning it, the way
 *     `report-addon-gate-blast-radius-script.spec.ts` and `prod-migrate-script.spec.ts` do.
 *
 * What must never regress: a refusal proposes NO tenant, `buildUpdates` emits one id-pinned,
 * still-NULL-guarded UPDATE per `ok` row and nothing for a refused one, `RouteRun` repairs are
 * emitted before the `RouteRunStop` repairs that depend on them whatever order the reports
 * arrive in, the one cascade level relaxes nothing else (a stop under a refused run stays
 * refused; a disagreeing RouteStop is still refused), and `--live` without an attested backup
 * dies before it can reach a database.
 *
 * The orphan-user task (`--deactivate-orphan-users`, owner decision 2026-09-05) is covered from
 * B6a below: it may only ever write the schema's INACTIVE status onto a NULL-tenant,
 * non-SUPER_ADMIN, non-deleted, currently-ACTIVE row; it never deletes, never writes a
 * `tenantId`, and it is refused outright when named alongside the tenant backfill.
 *
 * The unattended-write guard (`--only-test-tenants` + the restricted `--confirm "<phrase>"`,
 * 2026-09-05) is covered from B8a below plus the spawn-level B5m–B5p. What must never regress
 * there: the approved set is `scripts/lib/test-tenants.cjs`'s and is never widened, ONE
 * non-matching or unresolvable target row refuses the WHOLE batch, and `--confirm` cannot exist
 * without the guard — so a client tenant's rows keep the interactive TTY prompt as their only path.
 */

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-legacy-tenant-ids.mjs");
const LIB_HREF = pathToFileURL(
  path.resolve(API_DIR, "scripts/lib/legacy-tenant-backfill.mjs"),
).href;

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const ROW_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ROW_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

const GUARDED_UPDATE = (table: string) =>
  `UPDATE "${table}" SET "tenantId" = $1 WHERE "id" = $2 AND "tenantId" IS NULL RETURNING "id"`;

// `enum UserStatus` in apps/api/prisma/schema/tenancy.prisma is ACTIVE | INACTIVE | SUSPENDED,
// mirrored by `UserStatus` in packages/types/index.ts. The tool writes INACTIVE and only INACTIVE.
const ACTIVE = "ACTIVE";
const INACTIVE = "INACTIVE";
// Spelled out here rather than imported, so a change to the statement has to be made twice —
// once in the tool, once in the contract somebody reviews.
const GUARDED_USER_UPDATE =
  'UPDATE "User" SET "status" = $1, "updatedAt" = now() WHERE "id" = $2 AND "tenantId" IS NULL ' +
  'AND "role" <> \'SUPER_ADMIN\' AND "status" = $3 RETURNING "id"';

// ─── one child process evaluates every pure-module case ───────────────────────────────────────

const SHIM = `
import * as lib from "${LIB_HREF}";
const cases = JSON.parse(process.env.LTB_CASES);
const out = cases.map((c) => {
  try {
    if (c.kind === "routeRun") return { ok: true, value: lib.classifyRouteRun(c.row) };
    if (c.kind === "routeRunStop") return { ok: true, value: lib.classifyRouteRunStop(c.row) };
    if (c.kind === "paymentCounter") return { ok: true, value: lib.classifyPaymentCounter(c.row) };
    if (c.kind === "creditNote") return { ok: true, value: lib.classifyCreditNote(c.row) };
    if (c.kind === "orphanUser") return { ok: true, value: lib.classifyOrphanUser(c.row) };
    if (c.kind === "buildUpdates") return { ok: true, value: lib.buildUpdates(c.reports) };
    if (c.kind === "buildOrphanUserUpdates") {
      return { ok: true, value: lib.buildOrphanUserUpdates(c.reports) };
    }
    if (c.kind === "orphanUserUpdateSql") return { ok: true, value: lib.orphanUserUpdateSql() };
    if (c.kind === "assertTestTenantTargets") {
      return { ok: true, value: lib.assertTestTenantTargets(c.rows, c.slugById) };
    }
    throw new Error("unknown case kind: " + c.kind);
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
console.log(JSON.stringify(out));
`;

type Outcome = { ok: boolean; value?: unknown; message?: string };

function evaluate(cases: unknown[]): Outcome[] {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", SHIM], {
    encoding: "utf8",
    env: { ...process.env, LTB_CASES: JSON.stringify(cases) },
    timeout: 60_000,
  });
  if (res.status !== 0) {
    throw new Error(`legacy-tenant-backfill shim exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

const routeRun = (row: Record<string, unknown>) => ({ kind: "routeRun", row });
const routeRunStop = (row: Record<string, unknown>) => ({ kind: "routeRunStop", row });
const paymentCounter = (row: Record<string, unknown>) => ({ kind: "paymentCounter", row });
const creditNote = (row: Record<string, unknown>) => ({ kind: "creditNote", row });
const orphanUser = (row: Record<string, unknown>) => ({ kind: "orphanUser", row });
const buildUpdates = (reports: unknown[]) => ({ kind: "buildUpdates", reports });
const buildOrphanUserUpdates = (reports: unknown[]) => ({
  kind: "buildOrphanUserUpdates",
  reports,
});
const assertTestTenantTargets = (rows: unknown[], slugById: Record<string, string | null>) => ({
  kind: "assertTestTenantTargets",
  rows,
  slugById,
});

const OK_REPORT = {
  table: "RouteRunStop",
  id: ROW_1,
  verdict: "ok",
  tenantId: TENANT_A,
};
const REFUSED_REPORT = {
  table: "RouteRunStop",
  id: ROW_2,
  verdict: "refuse: parents disagree",
  tenantId: null,
};

const CASES = [
  // classifyRouteRunStop — 0..3
  routeRunStop({
    runTenantId: TENANT_A,
    routeStopTenantId: TENANT_A,
    routeTenantId: TENANT_A,
  }),
  routeRunStop({ runTenantId: null, routeStopTenantId: TENANT_A, routeTenantId: TENANT_A }),
  routeRunStop({ runTenantId: TENANT_A, routeStopTenantId: null, routeTenantId: null }),
  routeRunStop({ runTenantId: TENANT_A, routeStopTenantId: TENANT_A, routeTenantId: TENANT_B }),
  // classifyPaymentCounter — 4..7
  paymentCounter({ id: TENANT_A, parentTenantId: TENANT_A }),
  paymentCounter({ id: "singleton", parentTenantId: null }),
  paymentCounter({ id: "singleton", parentTenantId: TENANT_A }),
  paymentCounter({ id: ROW_1, parentTenantId: null }),
  // classifyCreditNote — 8..15
  // No invoice linked at all: `invoiceId` NULL, so the missing-parent checks do not apply.
  creditNote({
    customerTenantId: TENANT_A,
    invoiceId: null,
    invoiceRowId: null,
    invoiceTenantId: null,
    pairCollision: false,
  }),
  creditNote({
    customerTenantId: TENANT_A,
    invoiceId: ROW_1,
    invoiceRowId: ROW_1,
    invoiceTenantId: TENANT_A,
    pairCollision: false,
  }),
  creditNote({
    customerTenantId: null,
    invoiceId: ROW_1,
    invoiceRowId: ROW_1,
    invoiceTenantId: TENANT_A,
    pairCollision: false,
  }),
  creditNote({
    customerTenantId: TENANT_A,
    invoiceId: ROW_1,
    invoiceRowId: ROW_1,
    invoiceTenantId: TENANT_B,
    pairCollision: false,
  }),
  creditNote({
    customerTenantId: TENANT_A,
    invoiceId: null,
    invoiceRowId: null,
    invoiceTenantId: null,
    pairCollision: true,
  }),
  creditNote({
    customerTenantId: TENANT_A,
    invoiceId: ROW_1,
    invoiceRowId: ROW_1,
    invoiceTenantId: TENANT_B,
    pairCollision: true,
  }),
  // 14: invoiceId points at a row that is GONE (LEFT JOIN produced no Invoice at all)
  creditNote({
    customerTenantId: TENANT_A,
    invoiceId: ROW_2,
    invoiceRowId: null,
    invoiceTenantId: null,
    pairCollision: false,
  }),
  // 15: the linked Invoice exists but is itself an unrepaired NULL-tenant legacy row
  creditNote({
    customerTenantId: TENANT_A,
    invoiceId: ROW_2,
    invoiceRowId: ROW_2,
    invoiceTenantId: null,
    pairCollision: false,
  }),
  // buildUpdates — 16..20
  buildUpdates([
    OK_REPORT,
    REFUSED_REPORT,
    { table: "CreditNote", id: ROW_2, verdict: "ok", tenantId: TENANT_B, creditNoteNumber: "CN-1" },
    { table: "PaymentCounter", id: ROW_1, verdict: "refuse: singleton", tenantId: null },
  ]),
  buildUpdates([REFUSED_REPORT]),
  buildUpdates([{ table: "Tenant", id: ROW_1, verdict: "ok", tenantId: TENANT_A }]),
  buildUpdates([{ table: "RouteRunStop", id: ROW_1, verdict: "ok", tenantId: null }]),
  buildUpdates([
    { table: "CreditNote", id: ROW_1, verdict: "ok", tenantId: TENANT_A, creditNoteNumber: "CN-9" },
    { table: "CreditNote", id: ROW_2, verdict: "ok", tenantId: TENANT_A, creditNoteNumber: "CN-9" },
  ]),
  // ─── the RouteRun cascade level (2026-09-05 prod report: every NULL stop hung off a NULL run) ──
  // classifyRouteRun — 21..25
  routeRun({ routeRowId: ROW_1, routeTenantId: TENANT_A, stopTenantIds: [TENANT_A], stopCount: 4 }),
  // `array_agg` over zero rows is NULL, not []: a run with no stop carrying a RouteStop tenant
  // has nothing to contradict the Route and is still ok.
  routeRun({ routeRowId: ROW_1, routeTenantId: TENANT_A, stopTenantIds: null, stopCount: 0 }),
  routeRun({ routeRowId: null, routeTenantId: null, stopTenantIds: null, stopCount: 1 }),
  routeRun({ routeRowId: ROW_1, routeTenantId: null, stopTenantIds: [TENANT_A], stopCount: 1 }),
  routeRun({
    routeRowId: ROW_1,
    routeTenantId: TENANT_A,
    stopTenantIds: [TENANT_A, TENANT_B],
    stopCount: 2,
  }),
  // classifyRouteRunStop with the effective (about-to-be-written) run tenant — 26..28
  routeRunStop({
    runTenantId: null,
    effectiveRunTenantId: TENANT_A,
    routeStopTenantId: TENANT_A,
    routeTenantId: TENANT_A,
  }),
  // the run was REFUSED, so the CLI supplies no effective tenant and the stop stays refused
  routeRunStop({
    runTenantId: null,
    effectiveRunTenantId: null,
    routeStopTenantId: TENANT_A,
    routeTenantId: TENANT_A,
  }),
  routeRunStop({
    runTenantId: null,
    effectiveRunTenantId: TENANT_A,
    routeStopTenantId: TENANT_B,
    routeTenantId: TENANT_A,
  }),
  // buildUpdates parent-before-child ordering, with the reports deliberately the wrong way round — 29
  buildUpdates([
    { table: "RouteRunStop", id: ROW_2, verdict: "ok", tenantId: TENANT_A },
    { table: "RouteRun", id: ROW_1, verdict: "ok", tenantId: TENANT_A },
  ]),
  // ─── the orphan-user task (owner decision 2026-09-05: deactivate, never delete) ─────────────
  // classifyOrphanUser — 30..35
  orphanUser({ role: "TENANT_ADMIN", status: ACTIVE, deletedAt: null }),
  orphanUser({ role: "TENANT_ADMIN", status: INACTIVE, deletedAt: null }),
  // SUSPENDED is the third UserStatus value: also "not ACTIVE", so also nothing to do — the rule
  // is `status === ACTIVE`, never `status !== INACTIVE`.
  orphanUser({ role: "OPERATOR", status: "SUSPENDED", deletedAt: null }),
  orphanUser({ role: "SUPER_ADMIN", status: ACTIVE, deletedAt: null }),
  orphanUser({ role: "TENANT_ADMIN", status: ACTIVE, deletedAt: "2026-04-02T00:00:00.000Z" }),
  // precedence: a super admin that is ALSO deleted and ALSO inactive is still reported as the
  // super admin, so the strongest refusal is the one the owner reads.
  orphanUser({ role: "SUPER_ADMIN", status: INACTIVE, deletedAt: "2026-04-02T00:00:00.000Z" }),
  // buildOrphanUserUpdates — 36..38
  buildOrphanUserUpdates([
    { table: "User", id: ROW_1, verdict: "ok", newStatus: INACTIVE },
    { table: "User", id: ROW_2, verdict: "refuse: already inactive", newStatus: null },
  ]),
  buildOrphanUserUpdates([{ table: "User", id: ROW_1, verdict: "ok", newStatus: null }]),
  buildOrphanUserUpdates([{ table: "RouteRun", id: ROW_1, verdict: "ok", newStatus: INACTIVE }]),
  // the guarded statement itself — 39
  { kind: "orphanUserUpdateSql" },
  // ─── the --only-test-tenants guard (unattended writes, 2026-09-05) ──────────────────────────
  // assertTestTenantTargets — 40..45
  // 40: every target row lands in an approved test tenant
  assertTestTenantTargets(
    [
      { table: "RouteRun", id: ROW_1, tenantId: TENANT_A },
      { table: "RouteRunStop", id: ROW_2, tenantId: TENANT_B },
    ],
    { [TENANT_A]: "ux-audit-2026-09", [TENANT_B]: "test" },
  ),
  // 41: one of two rows lands in a client tenant — the WHOLE batch is refused
  assertTestTenantTargets(
    [
      { table: "RouteRun", id: ROW_1, tenantId: TENANT_A },
      { table: "RouteRunStop", id: ROW_2, tenantId: TENANT_B },
    ],
    { [TENANT_A]: "test", [TENANT_B]: "acme-widgets" },
  ),
  // 42: the proposed tenant id matches no Tenant row at all — unresolvable is a refusal, never
  // a pass-through: nothing can prove it is a test tenant.
  assertTestTenantTargets([{ table: "CreditNote", id: ROW_1, tenantId: TENANT_A }], {}),
  // 43: an empty write list has nothing to refuse
  assertTestTenantTargets([], {}),
  // 44: near-misses must NOT widen the policy — a prefix without the dash, a slug that merely
  // starts with the word, and the bare pattern stem are all client tenants here.
  assertTestTenantTargets(
    [
      { table: "RouteRun", id: ROW_1, tenantId: "t-1" },
      { table: "RouteRun", id: ROW_2, tenantId: "t-2" },
      { table: "RouteRunStop", id: ROW_1, tenantId: "t-3" },
    ],
    { "t-1": "testing-co", "t-2": "e2eclient", "t-3": "ux-audit" },
  ),
  // 45: the rest of the approved set, exactly as scripts/lib/test-tenants.cjs defines it
  assertTestTenantTargets(
    [
      { table: "RouteRun", id: ROW_1, tenantId: "t-1" },
      { table: "RouteRun", id: ROW_2, tenantId: "t-2" },
      { table: "RouteRunStop", id: ROW_1, tenantId: "t-3" },
      { table: "RouteRunStop", id: ROW_2, tenantId: "t-4" },
    ],
    { "t-1": "e2e-routeflow", "t-2": "routeflow-demo", "t-3": "qa-smoke", "t-4": "e2e-anything" },
  ),
];

const RESULTS = evaluate(CASES);

/** Every shim case must have run — a thrown shim would otherwise silently shorten the array. */
function outcome(index: number): Outcome {
  const result = RESULTS[index];
  if (!result) throw new Error(`legacy-tenant-backfill shim produced no result at index ${index}`);
  return result;
}

function verdictOf(index: number) {
  const result = outcome(index);
  expect(result.ok).toBe(true);
  return result.value as { verdict: string; tenantId: string | null; reason: string };
}

describe("legacy-tenant-backfill: classifyRouteRun", () => {
  it("B0a: ok — the Route names a tenant and every RouteStop under the run agrees", () => {
    const v = verdictOf(21);
    expect(v.verdict).toBe("ok");
    expect(v.tenantId).toBe(TENANT_A);
  });

  it("B0b: ok — a run whose stops carry no RouteStop tenant has nothing to contradict the Route", () => {
    // `array_agg` over zero rows returns NULL, not an empty array: the classifier must not read
    // that as "no Route tenant" and must not throw on it either.
    const v = verdictOf(22);
    expect(v.verdict).toBe("ok");
    expect(v.tenantId).toBe(TENANT_A);
  });

  it("B0c: refuse: parent missing — routeId points at a Route row that does not exist", () => {
    const v = verdictOf(23);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
    expect(v.reason).toMatch(/does not exist/);
  });

  it("B0d: refuse: parent missing — the parent Route is itself an unrepaired NULL-tenant row", () => {
    const v = verdictOf(24);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
    expect(v.reason).toMatch(/NULL tenantId/);
  });

  it("B0e: refuse: parents disagree — one stop's RouteStop names a different tenant", () => {
    const v = verdictOf(25);
    expect(v.verdict).toBe("refuse: parents disagree");
    expect(v.tenantId).toBeNull();
  });
});

describe("legacy-tenant-backfill: classifyRouteRunStop", () => {
  it("B1a: ok — RouteRun, RouteStop and Route all name the same tenant", () => {
    const v = verdictOf(0);
    expect(v.verdict).toBe("ok");
    expect(v.tenantId).toBe(TENANT_A);
  });

  it("B1b: refuse: parent missing — RouteRun has no tenant (row absent or its tenantId NULL)", () => {
    const v = verdictOf(1);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
    expect(v.reason).toContain("RouteRun");
  });

  it("B1c: refuse: parent missing names every ancestor that has no tenant", () => {
    const v = verdictOf(2);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
    expect(v.reason).toContain("RouteStop");
    expect(v.reason).toContain("Route");
  });

  it("B1d: refuse: parents disagree — two of three agreeing is NOT enough", () => {
    const v = verdictOf(3);
    expect(v.verdict).toBe("refuse: parents disagree");
    expect(v.tenantId).toBeNull();
  });

  it("B1e: ok via the run this batch repairs — the effective tenant stands in for a NULL run", () => {
    // The production shape: the stop's own RouteRun is NULL-tenant, but the CLI has already
    // classified that run `ok` off its Route and passes the tenant it is about to write.
    const v = verdictOf(26);
    expect(v.verdict).toBe("ok");
    expect(v.tenantId).toBe(TENANT_A);
    expect(v.reason).toMatch(/this batch will set/);
  });

  it("B1f: a stop under a REFUSED run gets no effective tenant and stays refused", () => {
    const v = verdictOf(27);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
    expect(v.reason).toContain("RouteRun");
  });

  it("B1g: the effective tenant relaxes nothing — a disagreeing RouteStop is still refused", () => {
    const v = verdictOf(28);
    expect(v.verdict).toBe("refuse: parents disagree");
    expect(v.tenantId).toBeNull();
  });
});

describe("legacy-tenant-backfill: classifyPaymentCounter", () => {
  it("B2a: ok — the counter id is itself the tenant id and a Tenant row matches", () => {
    const v = verdictOf(4);
    expect(v.verdict).toBe("ok");
    expect(v.tenantId).toBe(TENANT_A);
  });

  it("B2b: refuse: singleton — the literal `singleton` id is the pre-multi-tenant counter", () => {
    const v = verdictOf(5);
    expect(v.verdict).toBe("refuse: singleton");
    expect(v.tenantId).toBeNull();
  });

  it("B2c: the literal `singleton` is refused even if a Tenant row somehow matched", () => {
    const v = verdictOf(6);
    expect(v.verdict).toBe("refuse: singleton");
    expect(v.tenantId).toBeNull();
  });

  it("B2d: refuse: singleton — an id no Tenant row carries is not a tenant id", () => {
    const v = verdictOf(7);
    expect(v.verdict).toBe("refuse: singleton");
    expect(v.tenantId).toBeNull();
  });
});

describe("legacy-tenant-backfill: classifyCreditNote", () => {
  it("B3a: ok — tenant derived from Customer when there is no linked Invoice", () => {
    const v = verdictOf(8);
    expect(v.verdict).toBe("ok");
    expect(v.tenantId).toBe(TENANT_A);
  });

  it("B3b: ok — a linked Invoice that agrees does not change the derived tenant", () => {
    const v = verdictOf(9);
    expect(v.verdict).toBe("ok");
    expect(v.tenantId).toBe(TENANT_A);
  });

  it("B3c: refuse: parent missing — Customer row absent or its tenantId NULL", () => {
    const v = verdictOf(10);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
  });

  it("B3d: refuse: parents disagree — Invoice.tenantId differs from Customer.tenantId", () => {
    const v = verdictOf(11);
    expect(v.verdict).toBe("refuse: parents disagree");
    expect(v.tenantId).toBeNull();
  });

  it("B3e: refuse: unique-pair collision — (tenantId, creditNoteNumber) is already taken", () => {
    const v = verdictOf(12);
    expect(v.verdict).toBe("refuse: unique-pair collision");
    expect(v.tenantId).toBeNull();
  });

  it("B3f: a disagreeing Invoice outranks a collision — the worse problem is reported", () => {
    const v = verdictOf(13);
    expect(v.verdict).toBe("refuse: parents disagree");
    expect(v.tenantId).toBeNull();
  });

  it("B3g: refuse: parent missing — invoiceId is set but the Invoice row does not exist", () => {
    // Without `invoiceRowId` this is indistinguishable from "no invoice linked": both leave
    // `invoiceTenantId` NULL, and the row would have been ACCEPTED off the Customer alone with
    // one parent never inspected.
    const v = verdictOf(14);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
    expect(v.reason).toMatch(/does not exist/);
  });

  it("B3h: refuse: parent missing — the linked Invoice exists but its own tenantId is NULL", () => {
    const v = verdictOf(15);
    expect(v.verdict).toBe("refuse: parent missing");
    expect(v.tenantId).toBeNull();
    expect(v.reason).toMatch(/NULL tenantId/);
  });
});

describe("legacy-tenant-backfill: buildUpdates", () => {
  it("B4a: one id-pinned, still-NULL-guarded UPDATE per ok row and none for a refused row", () => {
    const result = outcome(16);
    expect(result.ok).toBe(true);
    const updates = result.value as Array<{
      table: string;
      id: string;
      tenantId: string;
      sql: string;
      params: [string, string];
    }>;

    expect(updates).toHaveLength(2);
    expect(updates.map((u) => `${u.table}:${u.id}`)).toEqual([
      `RouteRunStop:${ROW_1}`,
      `CreditNote:${ROW_2}`,
    ]);
    expect(updates[0].sql).toBe(GUARDED_UPDATE("RouteRunStop"));
    expect(updates[0].params).toEqual([TENANT_A, ROW_1]);
    expect(updates[1].sql).toBe(GUARDED_UPDATE("CreditNote"));
    expect(updates[1].params).toEqual([TENANT_B, ROW_2]);
    // No blanket repair: every statement pins one id the report already showed the owner.
    for (const update of updates) {
      expect(update.sql).toContain('WHERE "id" = $2 AND "tenantId" IS NULL');
      expect(update.sql).toContain('RETURNING "id"');
    }
  });

  it("B4b: a report with no ok row produces no statements at all", () => {
    const result = outcome(17);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual([]);
  });

  it("B4c: refuses a table outside the BACKFILL_TABLES whitelist (no identifier from a report)", () => {
    const result = outcome(18);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Tenant");
  });

  it("B4d: refuses an ok row that proposes no tenantId", () => {
    const result = outcome(19);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/tenantId/);
  });

  it("B4e: refuses the batch when two ok CreditNote rows claim the same (tenantId, number)", () => {
    // Per-row `pairCollision` cannot see this: both siblings still have a NULL tenantId, so
    // neither matches the other's EXISTS subquery — the constraint would only bite mid-transaction.
    const result = outcome(20);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("creditNoteNumber");
  });

  it("B4f: RouteRun updates precede RouteRunStop updates whatever order the reports arrive in", () => {
    // Parent before child, decided by BACKFILL_TABLES rather than by the caller: a stop repaired
    // before its run would be written against a tenant its own parent does not yet carry.
    const result = outcome(29);
    expect(result.ok).toBe(true);
    const updates = result.value as Array<{ table: string; id: string; sql: string }>;

    expect(updates.map((u) => `${u.table}:${u.id}`)).toEqual([
      `RouteRun:${ROW_1}`,
      `RouteRunStop:${ROW_2}`,
    ]);
    expect(updates[0].sql).toBe(GUARDED_UPDATE("RouteRun"));
  });
});

// ─── the orphan-user task ─────────────────────────────────────────────────────────────────────

function userVerdictOf(index: number) {
  const result = outcome(index);
  expect(result.ok).toBe(true);
  return result.value as { verdict: string; status: string | null; reason: string };
}

describe("legacy-tenant-backfill: classifyOrphanUser", () => {
  it("B6a: ok — an ACTIVE, non-deleted, non-SUPER_ADMIN row is deactivated (never deleted)", () => {
    const v = userVerdictOf(30);
    expect(v.verdict).toBe("ok");
    // The one value the tool may ever write, and it is the schema's, not a synonym.
    expect(v.status).toBe(INACTIVE);
    // The prose states the decision; B7a's statement is what proves it — a status change, and
    // no DELETE anywhere in the SQL this verdict produces.
    expect(v.reason).toMatch(/deactivate/i);
  });

  it("B6b: refuse: already inactive — INACTIVE proposes no write", () => {
    const v = userVerdictOf(31);
    expect(v.verdict).toBe("refuse: already inactive");
    expect(v.status).toBeNull();
  });

  it("B6c: refuse: already inactive — SUSPENDED is also not the active value", () => {
    const v = userVerdictOf(32);
    expect(v.verdict).toBe("refuse: already inactive");
    expect(v.status).toBeNull();
  });

  it("B6d: refuse: super admin — defensive, even though the listing's WHERE excludes the role", () => {
    const v = userVerdictOf(33);
    expect(v.verdict).toBe("refuse: super admin");
    expect(v.status).toBeNull();
  });

  it("B6e: refuse: deleted — a soft-deleted row is left exactly as it is", () => {
    const v = userVerdictOf(34);
    expect(v.verdict).toBe("refuse: deleted");
    expect(v.status).toBeNull();
  });

  it("B6f: the super-admin refusal outranks the deleted and already-inactive ones", () => {
    expect(userVerdictOf(35).verdict).toBe("refuse: super admin");
  });
});

describe("legacy-tenant-backfill: buildOrphanUserUpdates", () => {
  it("B7a: one guarded UPDATE per ok row, none for a refusal, and the exact statement", () => {
    const result = outcome(36);
    expect(result.ok).toBe(true);
    const updates = result.value as Array<{
      table: string;
      id: string;
      status: string;
      sql: string;
      params: [string, string, string];
    }>;

    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe("User");
    expect(updates[0].id).toBe(ROW_1);
    expect(updates[0].sql).toBe(GUARDED_USER_UPDATE);
    // $1 the value written, $2 the id the report showed, $3 the status the row must STILL have —
    // which is what makes a re-run a no-op and a row changed under us a rollback.
    expect(updates[0].params).toEqual([INACTIVE, ROW_1, ACTIVE]);
    // Every precondition the report displayed is re-stated in the WHERE.
    expect(updates[0].sql).toContain('"tenantId" IS NULL');
    expect(updates[0].sql).toContain("\"role\" <> 'SUPER_ADMIN'");
    expect(updates[0].sql).toContain('RETURNING "id"');
    // A status change, never a tenant write and never a delete.
    expect(updates[0].sql).not.toContain('"tenantId" =');
    expect(updates[0].sql).not.toMatch(/DELETE/i);
  });

  it("B7b: refuses an ok row that proposes anything but the inactive status", () => {
    const result = outcome(37);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(INACTIVE);
  });

  it("B7c: refuses a report for any table but User (no identifier from a report)", () => {
    const result = outcome(38);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("RouteRun");
  });

  it("B7d: orphanUserUpdateSql is the guarded statement verbatim", () => {
    const result = outcome(39);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(GUARDED_USER_UPDATE);
  });
});

describe("legacy-tenant-backfill: assertTestTenantTargets (--only-test-tenants)", () => {
  it("B8a: passes when every target row's tenant resolves to an approved test tenant", () => {
    const result = outcome(40);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual([
      { table: "RouteRun", id: ROW_1, tenantId: TENANT_A, slug: "ux-audit-2026-09" },
      { table: "RouteRunStop", id: ROW_2, tenantId: TENANT_B, slug: "test" },
    ]);
  });

  it("B8b: ONE client-tenant row refuses the whole batch, naming the id and the slug", () => {
    const result = outcome(41);

    expect(result.ok).toBe(false);
    // The count says "1 of 2", so the owner can see the refusal is not about every row...
    expect(result.message).toContain("1 of 2 target row(s)");
    // ...and the offender is identified by table, id and slug — never only by a count.
    expect(result.message).toContain(`RouteRunStop ${ROW_2}`);
    expect(result.message).toContain("tenantSlug=acme-widgets");
    // the compliant row is NOT listed as an offender
    expect(result.message).not.toContain(`RouteRun ${ROW_1}`);
    expect(result.message).toContain("NOTHING was written");
  });

  it("B8c: an unresolvable tenant id is an offender, not a pass-through", () => {
    const result = outcome(42);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(`CreditNote ${ROW_1}`);
    expect(result.message).toContain("tenantSlug=<unresolvable>");
  });

  it("B8d: an empty write list has nothing to refuse", () => {
    const result = outcome(43);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual([]);
  });

  it("B8e: the policy is never widened — a near-miss slug is a client tenant", () => {
    const result = outcome(44);

    expect(result.ok).toBe(false);
    // all three, so a single scan of the message shows every row that blocked the batch
    expect(result.message).toContain("3 of 3 target row(s)");
    expect(result.message).toContain("tenantSlug=testing-co");
    expect(result.message).toContain("tenantSlug=e2eclient");
    expect(result.message).toContain("tenantSlug=ux-audit");
  });

  it("B8f: the approved set is exactly scripts/lib/test-tenants.cjs's, patterns included", () => {
    const result = outcome(45);

    expect(result.ok).toBe(true);
    expect((result.value as { slug: string }[]).map((r) => r.slug)).toEqual([
      "e2e-routeflow",
      "routeflow-demo",
      "qa-smoke",
      "e2e-anything",
    ]);
  });
});

// ─── CLI: argument validation must precede any connection ─────────────────────────────────────

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...env, DATABASE_URL: "postgres://x" },
    timeout: 60_000,
  });
}

/** The CLI's non-comment lines — a claim in a comment must never satisfy a source pin. */
function cliCodeLines(): string {
  return fs
    .readFileSync(CLI, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
    )
    .join("\n");
}

describe("backfill-legacy-tenant-ids.mjs CLI contract", () => {
  it("B5a: --live without --backup-attested exits 2 without attempting a connection", () => {
    const res = runCli(["--live"]);

    expect(res.status).toBe(2);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("--backup-attested");
    // "before connecting": a DATABASE_URL pointing at a non-resolvable host is set, so a
    // driver-level failure would show up here if argument validation ran after the connection.
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|reach database/i);
    expect(res.stderr).not.toContain("Cannot find module");
  });

  it("B5b: an empty --backup-attested is not an attestation", () => {
    const res = runCli(["--live", "--backup-attested", "   "]);

    expect(res.status).toBe(2);
    expect(res.stdout + res.stderr).toContain("--backup-attested");
  });

  it("B5c: --dry-run and --live together are refused before connecting", () => {
    const res = runCli(["--dry-run", "--live", "--backup-attested", "backup 2026-09-05"]);

    expect(res.status).toBe(2);
    expect(res.stdout + res.stderr).toContain("mutually exclusive");
  });

  it("B5d: --help documents the modes and exit codes, and exits 0 without connecting", () => {
    const res = runCli(["--help"]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--dry-run");
    expect(res.stdout).toContain("--live");
    expect(res.stdout).toContain("--backup-attested");
    expect(res.stdout).toMatch(/Exit codes/i);
  });

  it("B5f: the CreditNote listing selects the joined Invoice id, not only its tenant", () => {
    // The classifier's missing-parent branches are unreachable without it: `invoiceTenantId`
    // alone reads NULL for "no invoice", "invoice gone" and "invoice itself NULL-tenant".
    expect(cliCodeLines()).toContain('i."id" AS "invoiceRowId"');
  });

  it("B5h: the RouteRun listing exists and feeds the stops the tenant it will write", () => {
    const code = cliCodeLines();

    // The cascade is only real if the CLI actually lists NULL-tenant runs...
    expect(code).toContain('FROM "RouteRun" rr');
    expect(code).toContain('WHERE rr."tenantId" IS NULL');
    // ...checks them against the RouteStops underneath...
    expect(code).toContain('array_agg(DISTINCT rs."tenantId")');
    // ...and hands the not-yet-written tenant to the stop classifier, flagged in the report.
    expect(code).toContain("effectiveRunTenantId");
    expect(code).toContain('"(via run repaired in this batch)"');
  });

  it("B5g: BACKFILL_CONFIRM_TOKEN is gated on JEST_WORKER_ID and never relaxes the attestation", () => {
    const code = cliCodeLines();
    expect(code).toContain("process.env.JEST_WORKER_ID");
    expect(code).toContain("WARNING: test override BACKFILL_CONFIRM_TOKEN active");
    expect(code).toContain("is ignored outside test");
    // --live still refuses without an attested backup, token or no token (B5a proves the exit)
    const res = runCli(["--live"]);
    expect(res.status).toBe(2);
  });

  it("B5i: naming both tasks is refused before connecting", () => {
    // The tenant backfill is the DEFAULT, so it is nameable explicitly for exactly this reason:
    // asking for both must be an error, never a silent choice of one.
    const res = runCli(["--backfill-tenants", "--deactivate-orphan-users"]);

    expect(res.status).toBe(2);
    expect(res.stdout + res.stderr).toContain("mutually exclusive");
    expect(res.stdout + res.stderr).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/i);
  });

  it("B5j: --deactivate-orphan-users --live still needs an attested backup", () => {
    const res = runCli(["--deactivate-orphan-users", "--live"]);

    expect(res.status).toBe(2);
    expect(res.stdout + res.stderr).toContain("--backup-attested");
    expect(res.stdout + res.stderr).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/i);
  });

  it("B5k: --help documents the second task, its confirmation phrase and its verdicts", () => {
    const res = runCli(["--help"]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--deactivate-orphan-users");
    expect(res.stdout).toContain("--backfill-tenants");
    expect(res.stdout).toContain("DEACTIVATE <n> USERS");
    expect(res.stdout).toContain("refuse: already inactive");
    expect(res.stdout).toContain("refuse: super admin");
    expect(res.stdout).toContain("refuse: deleted");
    // The decision, in the tool the owner runs — not only in a doc.
    expect(res.stdout).toMatch(/NEVER deleted/);
  });

  it("B5l: the User listing is scoped by the WHERE and selects nothing that identifies a person", () => {
    const code = cliCodeLines();

    expect(code).toContain('WHERE u."tenantId" IS NULL');
    // Written from the shared constant today; the literal form would be just as correct, so the
    // pin is on the EXCLUSION, not on which of the two spellings the query happens to use.
    expect(code).toMatch(/u\."role" <> '(\$\{SUPER_ADMIN_ROLE\}|SUPER_ADMIN)'/);
    // Output discipline is enforced by the SELECT list, not by remembering not to print things.
    expect(code).not.toMatch(/u\."email"|u\."username"|u\."password"|u\."googleId"/);
  });

  it("B5m: --confirm without --only-test-tenants exits 2 without attempting a connection", () => {
    // The unattended confirmation exists ONLY inside the test-tenant guard. With an attested
    // backup supplied, the guard rule is the only thing left that can refuse this invocation.
    const res = runCli([
      "--live",
      "--backup-attested",
      "backup 2026-09-05",
      "--confirm",
      "BACKFILL 1 ROWS",
    ]);

    expect(res.status).toBe(2);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("--confirm");
    expect(combined).toContain("--only-test-tenants");
    expect(combined).toContain("refused before opening any connection");
    // no driver load, no connection: the refusal is an argument decision, not a runtime one
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i);
    expect(res.stderr).not.toContain("Cannot find module");
  });

  it("B5n: --only-test-tenants is refused for the orphan-user task before connecting", () => {
    // Orphan users have no tenant at all, so the flag could not check anything — it is refused
    // rather than silently ignored, which would let it LOOK as though a guard had run.
    const res = runCli(["--deactivate-orphan-users", "--only-test-tenants"]);

    expect(res.status).toBe(2);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("not tenant-scoped");
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i);
  });

  it("B5o: --help documents the guard, the restricted --confirm and the exit codes", () => {
    const res = runCli(["--help"]);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--only-test-tenants");
    expect(res.stdout).toContain('--confirm "<phrase>"');
    // the policy module is named, so the reader knows where the approved list actually lives
    expect(res.stdout).toContain("scripts/lib/test-tenants.cjs");
    expect(res.stdout).toContain("BACKFILL <n> ROWS");
    expect(res.stdout).toMatch(/does NOT relax --backup-attested/);
  });

  it("B5p: the guard resolves slugs from Tenant and is applied to the write list, not the report", () => {
    const code = cliCodeLines();

    // The one query the guard needs — and it reads the TENANT the row would receive.
    expect(code).toContain('SELECT "slug" FROM "Tenant" WHERE "id" = $1');
    // The decision lives in the pure module; the CLI only feeds it the write list + the slugs.
    expect(code).toContain("assertTestTenantTargets(updates, slugById)");
    // The unattended confirmation is read from argv, never widened into the token's gate.
    expect(code).toContain("opts.confirm !== null ? opts.confirm : confirmTokenOverride()");
  });

  it("B5e: the session is declared read-only in code, not merely promised in a comment", () => {
    const code = cliCodeLines();

    expect(code).toContain("default_transaction_read_only = on");
    // The read-only flag may only be lifted inside the --live path, after the typed confirmation.
    expect(code).toContain("default_transaction_read_only = off");
    // Only the pure module may build a write statement, and only the guarded form.
    expect(code).not.toMatch(/UPDATE\s+"/);
  });
});
