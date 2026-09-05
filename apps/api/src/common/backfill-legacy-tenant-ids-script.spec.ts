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
 * still-NULL-guarded UPDATE per `ok` row and nothing for a refused one, and `--live` without an
 * attested backup dies before it can reach a database.
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

// ─── one child process evaluates every pure-module case ───────────────────────────────────────

const SHIM = `
import * as lib from "${LIB_HREF}";
const cases = JSON.parse(process.env.LTB_CASES);
const out = cases.map((c) => {
  try {
    if (c.kind === "routeRunStop") return { ok: true, value: lib.classifyRouteRunStop(c.row) };
    if (c.kind === "paymentCounter") return { ok: true, value: lib.classifyPaymentCounter(c.row) };
    if (c.kind === "creditNote") return { ok: true, value: lib.classifyCreditNote(c.row) };
    if (c.kind === "buildUpdates") return { ok: true, value: lib.buildUpdates(c.reports) };
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

const routeRunStop = (row: Record<string, unknown>) => ({ kind: "routeRunStop", row });
const paymentCounter = (row: Record<string, unknown>) => ({ kind: "paymentCounter", row });
const creditNote = (row: Record<string, unknown>) => ({ kind: "creditNote", row });
const buildUpdates = (reports: unknown[]) => ({ kind: "buildUpdates", reports });

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

  it("B4c: refuses a table outside the three-table whitelist (no identifier from a report)", () => {
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

  it("B5g: BACKFILL_CONFIRM_TOKEN is gated on JEST_WORKER_ID and never relaxes the attestation", () => {
    const code = cliCodeLines();
    expect(code).toContain("process.env.JEST_WORKER_ID");
    expect(code).toContain("WARNING: test override BACKFILL_CONFIRM_TOKEN active");
    expect(code).toContain("is ignored outside test");
    // --live still refuses without an attested backup, token or no token (B5a proves the exit)
    const res = runCli(["--live"]);
    expect(res.status).toBe(2);
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
