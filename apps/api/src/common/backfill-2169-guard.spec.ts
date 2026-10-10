import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #2169 / SA-403 — the pre-connection argument gates of
 * apps/api/scripts/backfill-2169-nsf-system-kind.mjs.
 *
 * This spec spawns the REAL script (never imports it, never mocks it) with a child environment
 * that carries NO database variables at all — DATABASE_URL and every RAILWAY_, POSTGRES_ and PG
 * -prefixed variable are deleted, not replaced with a fake value. Every case here must be refused
 * as an ARGUMENT decision, before the script ever tries to resolve or open a connection: a stray
 * connection-refused or DNS-lookup error in stderr would mean a gate ran too late (or not at all)
 * and the script reached for a database it was never given.
 *
 * The pure allow-list / live-tenant-confirmation / exclusion-list logic (which DOES need a slug
 * lookup and so cannot be exercised without a database) is instead covered by the script's own
 * `--self-test`, run here the same way (spawned, no DB env) purely to assert its exit code and
 * that it never prints one of its internal fake ids.
 */

const SCRIPT = require.resolve("../../scripts/backfill-2169-nsf-system-kind.mjs");
const API_DIR = join(__dirname, "..", "..");
const REPO_ROOT = join(API_DIR, "..", "..");

function noDbEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "DATABASE_URL" ||
      key.startsWith("RAILWAY_") ||
      key.startsWith("POSTGRES_") ||
      key.startsWith("PG")
    ) {
      delete env[key];
    }
  }
  return env;
}

/** SA-403 (e): no output path — abort, dry run or self-test — ever prints a UUID-shaped id. */
const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function run(args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...noDbEnv(), ...envOverrides },
    timeout: 60_000,
  });
  expect(`${res.stdout ?? ""}${res.stderr ?? ""}`).not.toMatch(UUID_SHAPED);
  return res;
}

const NO_CONNECTION_ATTEMPT = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|getaddrinfo|Cannot find module/i;

const BASE_APPLY_ARGS = [
  "--apply",
  "--plan",
  "/nonexistent/plan.json",
  "--confirm-plan",
  "deadbeef",
  "--guard-sha",
  "0000000000000000000000000000000000000000",
  "--i-have-a-fresh-backup",
];

describe("backfill-2169-nsf-system-kind.mjs — pre-connection gates (REG-2169, SA-403)", () => {
  it("(i) --apply with no exclusion list at all exits 1 and names the missing list, before connecting", () => {
    const res = run(BASE_APPLY_ARGS);

    expect(res.status).toBe(1);
    const out = res.stdout + res.stderr;
    expect(out).toContain("B2169_EXCLUDE_TENANT_IDS");
    expect(out).toContain("--exclude-file");
    expect(out).not.toMatch(NO_CONNECTION_ATTEMPT);
  });

  it("(ii) an all-whitespace B2169_EXCLUDE_TENANT_IDS exits 1 as empty, before connecting", () => {
    const res = run(BASE_APPLY_ARGS, { B2169_EXCLUDE_TENANT_IDS: "  , " });

    expect(res.status).toBe(1);
    const out = res.stdout + res.stderr;
    expect(out).toContain("empty");
    expect(out).not.toMatch(NO_CONNECTION_ATTEMPT);
  });

  it("(iii) an --exclude-file resolving inside the repository exits 1, before connecting", () => {
    // A real, existing file inside the repo — the CLI itself is a fine, harmless choice.
    const res = run([...BASE_APPLY_ARGS, "--exclude-file", SCRIPT]);

    expect(res.status).toBe(1);
    const out = res.stdout + res.stderr;
    expect(out).toMatch(/outside the repository/i);
    expect(out).not.toMatch(NO_CONNECTION_ATTEMPT);
  });

  it("(plan-hash) a --confirm-plan that does not match the plan file's own hash exits 1, before connecting", () => {
    const dir = mkdtempSync(join(tmpdir(), "b2169-plan-"));
    const excludeFile = join(dir, "exclude.txt");
    const planFile = join(dir, "plan.json");
    try {
      writeFileSync(excludeFile, "tenant-fake-excl-1\n");
      writeFileSync(
        planFile,
        JSON.stringify({
          generatedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: { database: "x", tenantIds: [] },
          apply: [],
          exclusionHash: "will-not-match-anyway",
          planHash: "will-not-match-anyway",
          review: [],
          excludedSummary: null,
        }),
      );

      const res = run([
        "--apply",
        "--plan",
        planFile,
        "--confirm-plan",
        "deadbeef",
        "--guard-sha",
        "0000000000000000000000000000000000000000",
        "--i-have-a-fresh-backup",
        "--exclude-file",
        excludeFile,
      ]);

      expect(res.status).toBe(1);
      const out = res.stdout + res.stderr;
      expect(out).toContain("--confirm-plan");
      expect(out).toContain("does not match");
      expect(out).not.toMatch(NO_CONNECTION_ATTEMPT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(iv) dry run is the default: with no --apply and no DB env, it fails resolving a DB target, not a guard", () => {
    const res = run([]);

    // Exit 2 is this script's own "env/connection error" code (never a guard refusal's exit 1),
    // and the message must be the resolver's own "no target configured" complaint — not a driver-
    // level failure, which would mean the code tried to actually reach a host.
    expect(res.status).toBe(2);
    const out = res.stdout + res.stderr;
    expect(out).toMatch(/Missing Railway proxy variables|No DATABASE_URL/);
    expect(out).not.toMatch(NO_CONNECTION_ATTEMPT);
  });

  it("(v) --self-test exits 0 and never prints one of its own internal fake ids/slugs", () => {
    // Even an attacker-controlled exclusion env var must not leak into --self-test's output: the
    // self-test never reads process.env for its exclusion-list cases (every case passes its own
    // explicit env), so this should be a no-op either way.
    const res = run(["--self-test"], { B2169_EXCLUDE_TENANT_IDS: "tenant-should-never-print" });

    expect(res.status).toBe(0);
    const out = res.stdout + res.stderr;
    expect(out).not.toContain("tenant-should-never-print");
    expect(out).not.toContain("tenant-excl-1");
    expect(out).not.toContain("tenant-excl-2");
    expect(out).not.toContain("tenant-keep-1");
    expect(out).not.toContain("live-fake-1");
    expect(out).toMatch(/self-test: all \d+ passed/);
  });
});

describe("backfill-2169-nsf-system-kind.mjs — B768 DB-URL discipline", () => {
  it("resolves through the shared resolver rather than naming DATABASE_URL directly", () => {
    // Mirrors owner-report-db-url.spec.ts's ALLOWED-list convention: this script is a gated
    // WRITER (like backfill-b294-order-line-taxrate.mjs), so DATABASE_URL appears only in
    // --local-mode help/log text, never as the production read path.
    const fs = require("fs") as typeof import("fs");
    const src = fs.readFileSync(SCRIPT, "utf8");
    expect(src).toContain("resolveDatabaseUrl");
    expect(src).toContain("requireProxy: !local");
  });
});

// Sanity: REPO_ROOT actually points at the repository root this script's own REPO_ROOT computes,
// so the "(iii) inside the repo" case above is testing what it claims to.
describe("test setup sanity", () => {
  it("SCRIPT lives under REPO_ROOT", () => {
    expect(SCRIPT.startsWith(REPO_ROOT)).toBe(true);
  });
});
