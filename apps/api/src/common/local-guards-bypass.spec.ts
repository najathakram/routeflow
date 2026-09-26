import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { NON_LOCAL_DB_URLS } from "./local-db-bypass-urls";

/**
 * #2204: every `--local` / seed guard refuses the SAME bypass list the helper's spec pins (#2162). Each guard
 * is run as the real script with a bypass URL: it must refuse BEFORE dialling anything (a `?host=prod` URL
 * used to pass the old hostname allowlist). The positive control shows a genuinely local URL gets past the guard
 * (so the refusal is the guard's, not a script that always fails).
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
    name: "data-questions-report",
    cmd: mjs("data-questions-report.mjs", "--local"),
    refusal: /not provably local|requires DATABASE_URL/,
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
    cmd: ["npx", "tsx", "prisma/seed.ts"],
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

describe("every --local / seed guard refuses the helper's bypass list (#2204)", () => {
  describe.each(GUARDS)("$name", (g) => {
    it.each(NON_LOCAL_DB_URLS.map((r) => [...r]))(
      "refuses %s",
      (_label, url) => {
        const { status, out } = run(g, url);
        expect(status).not.toBe(0);
        expect(out).toMatch(g.refusal);
      },
      70_000,
    );

    if (g.control) {
      it("control: a provably local URL passes the guard (fails later, at the connection)", () => {
        const { out } = run(g, LOCAL_CLOSED_PORT);
        expect(out).not.toMatch(g.refusal);
      }, 70_000);
    }
  });
});
