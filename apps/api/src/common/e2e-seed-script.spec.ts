import { spawnSync } from "node:child_process";
import path from "node:path";

// Tooling lesson (railway-run-target) — apps/api/scripts/e2e-seed.js contract.
//
// The script used to default DATABASE_URL to a hardcoded localhost URL, so a run under
// `railway run --service postgres` (which exposes only POSTGRES_USER/POSTGRES_PASSWORD/
// POSTGRES_DB/RAILWAY_TCP_PROXY_DOMAIN/RAILWAY_TCP_PROXY_PORT — never DATABASE_URL) silently
// seeded the LOCAL dev database instead of the intended target. It now resolves its target
// through the shared apps/api/scripts/lib/railway-db-url.mjs helper (same one prod-migrate.mjs
// and schema-drift.mjs use) and always logs the resolved host — never the password — before
// connecting. These cases drive the real script via spawnSync with `--print-target` and
// assert what it prints, which is deterministic and never touches a database.
//
// `--print-target` makes the script exit 0 right after logging its resolved target, before
// opening any Pool/PrismaClient connection — so this spec never needs a reachable (or
// deliberately unreachable) Postgres behind the resolved address. That matters most for case
// (c): without the flag it would run the real script against its hardcoded local-dev default
// (localhost:5432/routeflow_dev), which a developer's machine may legitimately have live via
// `npm run db:up` — a Jest spec must never touch a database, seeded or otherwise.

const SCRIPT = path.resolve(__dirname, "../../scripts/e2e-seed.js");

function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [SCRIPT, "--print-target"], {
    encoding: "utf8",
    env,
    timeout: 20_000,
  });
}

describe("e2e-seed.js DATABASE_URL resolution (tooling lesson: railway-run-target)", () => {
  it("DATABASE_URL wins when the Railway proxy vars are absent", () => {
    const res = run(scrubbedEnv({ DATABASE_URL: "postgresql://u:p@127.0.0.1:65533/testdb" }));
    const combined = res.stdout + res.stderr;

    expect(combined).not.toContain("Cannot find module");
    expect(res.stdout).toContain("e2e-seed: target host = 127.0.0.1:65533/testdb");
    expect(res.stdout).not.toContain("using the local default");
    // --print-target exits 0 right after printing — no connection is ever attempted.
    expect(res.status).toBe(0);
  });

  it("POSTGRES_* builds the resolved URL (encoded password, wins over an incomplete/other DATABASE_URL)", () => {
    const res = run(
      scrubbedEnv({
        // Present but must be IGNORED: proxy vars win over DATABASE_URL (the same priority
        // prod-migrate.mjs/schema-drift.mjs use, documented in railway-db-url.mjs — under
        // `railway run` DATABASE_URL is the unreachable *.railway.internal host).
        DATABASE_URL: "postgresql://ignored:ignored@example.invalid:1/ignored",
        POSTGRES_USER: "u",
        POSTGRES_PASSWORD: "p@ss:word",
        POSTGRES_DB: "testdb",
        RAILWAY_TCP_PROXY_DOMAIN: "127.0.0.1",
        RAILWAY_TCP_PROXY_PORT: "65533",
      }),
    );
    const combined = res.stdout + res.stderr;

    // A correctly encoded password is a precondition for `new URL()` (used to derive the
    // logged host) parsing the authority section right at all — an unencoded "@" or ":"
    // in the password would corrupt host/port parsing and this line would show something
    // other than the real target.
    expect(res.stdout).toContain("e2e-seed: target host = 127.0.0.1:65533/testdb");
    expect(combined).not.toContain("example.invalid");
    expect(combined).not.toContain("p@ss:word");
    expect(combined).not.toContain(encodeURIComponent("p@ss:word"));
    // --print-target exits 0 right after printing — no connection is ever attempted.
    expect(res.status).toBe(0);
  });

  it("falls back to the local default — loudly — when neither DATABASE_URL nor POSTGRES_* are set", () => {
    const res = run(scrubbedEnv());

    expect(res.stdout).toContain(
      "e2e-seed: DATABASE_URL not set and no POSTGRES_* vars — using the local default",
    );
    expect(res.stdout).toContain("e2e-seed: target host = localhost:5432/routeflow_dev");
    // --print-target exits before the script would otherwise connect to that local
    // default — deterministic regardless of whether this box has `npm run db:up` live.
    expect(res.status).toBe(0);
  });
});
