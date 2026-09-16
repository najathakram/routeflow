import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Post-dated check payments PR-1 — contract for the checkDate catch-up backfill:
 * `apps/api/scripts/backfill-check-dates.mjs` and its pure decision layer
 * `apps/api/scripts/lib/check-date-backfill.mjs`.
 *
 * No database is touched here (mirrors `backfill-legacy-tenant-ids-script.spec.ts`): the pure
 * module is ESM (`.mjs`) and this suite runs under ts-jest's CommonJS transform, so every case
 * is evaluated in ONE `node --input-type=module` child that imports the real module by
 * `file://` URL and prints a JSON array. A separate `.db.spec.ts` (this repo's DB-lane
 * convention, run only via `npm run local:test:db` against a real Postgres) proves the actual
 * read → write → re-read round trip; it cannot run in an environment with no database, which is
 * exactly why the decision logic is factored out here to be lockable without one.
 *
 * What must never regress: `status` is never proposed for change (the plan objects this module
 * produces carry no `status` field at all — proof by construction); a row already CLEARED/
 * BOUNCED, non-CHECK, DRAFT/VOID, or already carrying a `checkDate` is left alone; only a
 * `settledAt` STRICTLY AFTER the cutoff qualifies (a settledAt at or before the cutoff predates
 * the post-dated-check feature and needs no checkDate); `deriveCheckDate` always truncates to a
 * UTC calendar day, independent of the host's local timezone.
 */

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-check-dates.mjs");
const LIB_HREF = pathToFileURL(path.resolve(API_DIR, "scripts/lib/check-date-backfill.mjs")).href;

const SHIM = `
import * as lib from "${LIB_HREF}";
const cases = JSON.parse(process.env.CDB_CASES);
const out = cases.map((c) => {
  try {
    if (c.kind === "shouldBackfill") {
      return { ok: true, value: lib.shouldBackfillCheckDate(c.row, c.since) };
    }
    if (c.kind === "deriveCheckDate") {
      return { ok: true, value: lib.deriveCheckDate(c.settledAt).toISOString() };
    }
    if (c.kind === "plan") {
      const result = lib.planCheckDateBackfill(c.rows, c.since).map((r) => ({
        ...r,
        checkDate: r.checkDate.toISOString(),
      }));
      return { ok: true, value: result };
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
    env: { ...process.env, CDB_CASES: JSON.stringify(cases) },
    timeout: 60_000,
  });
  if (res.status !== 0) {
    throw new Error(`check-date-backfill shim exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

const SINCE = "2026-09-15T00:00:00.000Z";
const FUTURE = "2026-10-01T00:00:00.000Z";
const PAST = "2026-09-01T00:00:00.000Z";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    tenantId: "tenant-1",
    invoiceId: "inv-1",
    method: "CHECK",
    status: "PAID",
    checkStatus: "RECORDED",
    checkDate: null,
    settledAt: FUTURE,
    ...overrides,
  };
}

const CASES = [
  { kind: "shouldBackfill", row: row(), since: SINCE }, // 0: qualifies
  { kind: "shouldBackfill", row: row({ method: "CASH" }), since: SINCE }, // 1: non-CHECK
  { kind: "shouldBackfill", row: row({ status: "DRAFT" }), since: SINCE }, // 2: DRAFT
  { kind: "shouldBackfill", row: row({ status: "VOID" }), since: SINCE }, // 3: VOID
  { kind: "shouldBackfill", row: row({ checkStatus: "CLEARED" }), since: SINCE }, // 4: CLEARED
  { kind: "shouldBackfill", row: row({ checkStatus: "BOUNCED" }), since: SINCE }, // 5: BOUNCED
  { kind: "shouldBackfill", row: row({ checkStatus: "DEPOSITED" }), since: SINCE }, // 6: DEPOSITED still qualifies
  { kind: "shouldBackfill", row: row({ checkDate: "2026-09-20" }), since: SINCE }, // 7: already backfilled
  { kind: "shouldBackfill", row: row({ settledAt: PAST }), since: SINCE }, // 8: settled before cutoff
  { kind: "shouldBackfill", row: row({ settledAt: SINCE }), since: SINCE }, // 9: settled EXACTLY at cutoff (not strictly after)
  { kind: "shouldBackfill", row: row({ settledAt: null }), since: SINCE }, // 10: no settledAt at all
  { kind: "deriveCheckDate", settledAt: "2026-10-01T23:59:59.000Z" }, // 11: UTC day truncation
  {
    kind: "plan",
    since: SINCE,
    rows: [
      row({ id: "pay-future" }),
      row({ id: "pay-cleared", checkStatus: "CLEARED" }),
      row({ id: "pay-cash", method: "CASH" }),
      row({ id: "pay-draft", status: "DRAFT" }),
      row({ id: "pay-past", settledAt: PAST }),
    ],
  }, // 12: only pay-future survives
];

const RESULTS = evaluate(CASES);

function outcome(index: number): Outcome {
  const result = RESULTS[index];
  if (!result) throw new Error(`check-date-backfill shim produced no result at index ${index}`);
  return result;
}

describe("check-date-backfill: shouldBackfillCheckDate", () => {
  it("REG-PR1-CHK1: a future-settledAt PAID CHECK (RECORDED) qualifies", () => {
    const o = outcome(0);
    expect(o.ok).toBe(true);
    expect(o.value).toBe(true);
  });

  it("REG-PR1-CHK2: a non-CHECK method never qualifies", () => {
    expect(outcome(1).value).toBe(false);
  });

  it("REG-PR1-CHK3: DRAFT status never qualifies (status is never re-derived here)", () => {
    expect(outcome(2).value).toBe(false);
  });

  it("REG-PR1-CHK4: VOID status never qualifies", () => {
    expect(outcome(3).value).toBe(false);
  });

  it("REG-PR1-CHK5: an already-CLEARED check never qualifies", () => {
    expect(outcome(4).value).toBe(false);
  });

  it("REG-PR1-CHK6: an already-BOUNCED check never qualifies", () => {
    expect(outcome(5).value).toBe(false);
  });

  it("REG-PR1-CHK7: a DEPOSITED (not yet cleared/bounced) check still qualifies", () => {
    expect(outcome(6).value).toBe(true);
  });

  it("REG-PR1-CHK8: a row that already carries a checkDate is left alone (idempotent rerun)", () => {
    expect(outcome(7).value).toBe(false);
  });

  it("REG-PR1-CHK9: a settledAt at or before the cutoff never qualifies", () => {
    expect(outcome(8).value).toBe(false);
  });

  it("REG-PR1-CHK10: a settledAt exactly AT the cutoff is not strictly after it", () => {
    expect(outcome(9).value).toBe(false);
  });

  it("REG-PR1-CHK11: a missing settledAt never qualifies", () => {
    expect(outcome(10).value).toBe(false);
  });
});

describe("check-date-backfill: deriveCheckDate", () => {
  it("REG-PR1-CHK12: truncates to the UTC calendar day, independent of time-of-day", () => {
    const o = outcome(11);
    expect(o.ok).toBe(true);
    expect(o.value).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("check-date-backfill: planCheckDateBackfill", () => {
  it("REG-PR1-CHK13: only the qualifying row survives, and the plan never carries a status field", () => {
    const o = outcome(12);
    expect(o.ok).toBe(true);
    const plan = o.value as Array<Record<string, unknown>>;
    expect(plan.map((r) => r.id)).toEqual(["pay-future"]);
    expect(plan[0]).not.toHaveProperty("status");
    expect(plan[0].checkDate).toBe("2026-10-01T00:00:00.000Z");
  });
});

// ─── CLI: --since argument validation must precede any connection ─────────────────────────────

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    // An unreachable host: if argument validation ran AFTER opening a connection, this would
    // surface as a driver-level ECONNREFUSED/ENOTFOUND instead of the clean argument error.
    env: { ...env, DATABASE_URL: "postgres://x:x@127.0.0.1:1/nonexistent" },
    timeout: 60_000,
  });
}

describe("backfill-check-dates.mjs CLI contract", () => {
  it("REG-PR1-CHK14: --since given twice is refused before connecting", () => {
    const res = runCli([
      "--since",
      "2026-09-15T00:00:00.000Z",
      "--since",
      "2026-10-01T00:00:00.000Z",
    ]);
    expect(res.status).toBe(1);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("--since may be given only once");
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i);
  });

  it("REG-PR1-CHK15: an invalid --since value is refused before connecting", () => {
    const res = runCli(["--since", "not-a-date"]);
    expect(res.status).toBe(1);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("--since is not a valid date");
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i);
  });

  it("REG-PR1-CHK16: defaults --since to the migration's own instant, never bare 'now'", () => {
    const code = require("fs").readFileSync(CLI, "utf8");
    expect(code).toContain("2026-09-16T01:00:00.000Z");
    expect(code).not.toMatch(/new Date\(\)\s*;?\s*$/m);
  });

  it("REG-PR1-CHK17: the write statement names only checkDate — status is never in its data clause", () => {
    const code = require("fs").readFileSync(CLI, "utf8");
    const dataBlockMatch = code.match(/data:\s*\{([^}]*)\}/);
    expect(dataBlockMatch).not.toBeNull();
    expect(dataBlockMatch![1]).toContain("checkDate");
    expect(dataBlockMatch![1]).not.toContain("status");
  });

  it("REG-PR1-CHK18: --tenant-id given twice is refused before connecting", () => {
    const res = runCli(["--tenant-id", "t1", "--tenant-id", "t2"]);
    expect(res.status).toBe(1);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain("--tenant-id may be given only once");
    expect(combined).not.toMatch(/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo/i);
  });

  it("REG-PR1-CHK19: --tenant-id scopes both the scan and the write (L-129 — a spec/rehearsal must never run unscoped)", () => {
    const code = require("fs").readFileSync(CLI, "utf8");
    const occurrences = code.match(/\.\.\.\(tenantId \? \{ tenantId \} : \{\}\)/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
