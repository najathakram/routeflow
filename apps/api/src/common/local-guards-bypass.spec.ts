import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NON_LOCAL_DB_URLS } from "./local-db-bypass-urls";

/**
 * #2204: every `--local` / seed guard refuses the bypass list the helper's spec pins (#2162). The full 16-URL list
 * runs against the shared guard function; each real script is then spawned ONCE with a bypass URL (~14 spawns,
 * not one per URL: spawn-heavy default-lane specs are the load flakes of #2146/#2192) to prove it calls the guard
 * before dialling, plus a local control per pg script.
 */
const api = resolve(__dirname, "../..");
const LOCAL_CLOSED_PORT = "postgresql://u:p@127.0.0.1:1/x"; // provably local; nothing listens, so pg fails to connect

interface Guard {
  name: string;
  cmd: string[];
  refusal: RegExp;
  /** run the local control (skipped where a local run would start real work). */
  control: boolean;
}
const mjs = (file: string, ...args: string[]) => ["node", `scripts/${file}`, ...args];
const GUARDS: Guard[] = [
  {
    name: "t6-drop-guards (DESTRUCTIVE under --local)",
    cmd: mjs("t6-drop-guards.mjs", "--local", "--yes-drop-t6-guards"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "t6-backfill-census",
    cmd: mjs("t6-backfill-census.mjs", "--local"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "t6-null-census",
    cmd: mjs("t6-null-census.mjs", "--local"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "t6-null-rows-report",
    cmd: mjs("t6-null-rows-report.mjs", "--local"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "t6-stamp-null-rows",
    cmd: mjs("t6-stamp-null-rows.mjs", "--local", "--table", "CreditNote"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "stamp-addon-comp (a WRITER under --apply)",
    cmd: mjs("stamp-addon-comp.mjs", "--local", "--ids", "00000000-0000-4000-8000-000000000001"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "data-questions-report",
    cmd: mjs("data-questions-report.mjs", "--local"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "backfill-b294-order-line-taxrate (a WRITER under --apply)",
    cmd: mjs("backfill-b294-order-line-taxrate.mjs", "--local"),
    refusal: /refuses a non-local host|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "sa077-split-qty-consistency",
    cmd: mjs("sa077-split-qty-consistency.mjs", "--local"),
    refusal: /refuses a non-local host|requires DATABASE_URL/,
    control: true,
  },
  {
    name: "schema-drift",
    cmd: mjs("schema-drift.mjs", "--local"),
    refusal: /not provably local|requires DATABASE_URL/,
    control: false,
  },
  {
    name: "prisma/seed.ts assertSafeTarget",
    cmd: [process.execPath, "-r", "ts-node/register/transpile-only", "prisma/seed.ts"],
    refusal: /Refusing to seed the non-local database|missing or unparseable/,
    control: false,
  },
];

function run(g: Guard, url: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url };
  for (const k of Object.keys(env)) if (/^(RAILWAY_|POSTGRES_)/.test(k)) delete env[k];
  delete env.SEED_ALLOW_REMOTE;
  delete env.NODE_ENV;
  const r = spawnSync(g.cmd[0], g.cmd.slice(1), {
    cwd: api,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// ONE spawn hosts the whole 16-URL list against the mjs guard function (Jest cannot import ESM here); the
// helper's own spec (local-db-target.spec.ts) and db-spec.spec.ts run the same list fully in-process.
function requireLocalPgConfigVerdicts(): Array<{ url: string; refused: boolean }> {
  const code = `
    import("./scripts/lib/local-pg-config.mjs").then(({ requireLocalPgConfig }) => {
      const urls = JSON.parse(process.env.URLS);
      console.log(JSON.stringify(urls.map((url) => {
        try { requireLocalPgConfig(url); return { url, refused: false }; } catch { return { url, refused: true }; }
      })));
    });`;
  const r = spawnSync("node", ["-e", code], {
    cwd: api,
    encoding: "utf8",
    env: { ...process.env, URLS: JSON.stringify(NON_LOCAL_DB_URLS.map(([, u]) => u)) },
  });
  return JSON.parse(r.stdout);
}

it("e2e-seed.js dials the vetted fields for a provably-local target (a static pin: the script seeds prod too)", () => {
  const src = readFileSync(resolve(api, "scripts/e2e-seed.js"), "utf8");
  expect(src).toMatch(
    /new Pool\(localConnectionConfig\(dbUrl\) \?\? \{ connectionString: dbUrl \}\)/,
  );
  expect(src).not.toMatch(/new Pool\(\{ connectionString: dbUrl \}\)/);
});

describe("every --local / seed guard refuses the helper's bypass list (#2204)", () => {
  it("requireLocalPgConfig (shared by the pg scripts) refuses every URL on the bypass list", () => {
    const verdicts = requireLocalPgConfigVerdicts();
    expect(verdicts).toHaveLength(NON_LOCAL_DB_URLS.length);
    expect(verdicts.filter((v) => !v.refused)).toEqual([]);
  });

  // ONE bypass URL per guard proves the script really calls the guard BEFORE dialling anything (a `?host=prod`
  // URL used to pass the old hostname allowlist); the local control proves the refusal is the guard's.
  const BYPASS = "postgresql://u:p@localhost:5432/x?host=prod.invalid";
  describe.each(GUARDS)("$name", (g) => {
    it("refuses a ?host= bypass before dialling", () => {
      const { status, out } = run(g, BYPASS);
      expect(status).not.toBe(0);
      expect(out).toMatch(g.refusal);
      // ORDERING: the guard ran BEFORE anything was resolved or dialled (no target banner, no DNS/connect error)
      expect(out).not.toMatch(/: target |ENOTFOUND|ECONNREFUSED/);
    }, 70_000);

    if (g.control) {
      it("control: a provably local URL passes the guard (fails later, at the connection)", () => {
        const { out } = run(g, LOCAL_CLOSED_PORT);
        expect(out).not.toMatch(g.refusal);
      }, 70_000);
    }
  });
});
