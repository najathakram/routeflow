import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// backup-production.mjs's trust decisions, unit-tested without a database, Railway link or
// pg_dump. The libs are ESM (`.mjs`) and this suite runs under ts-jest's CommonJS transform, so
// each case spawns a tiny `node --input-type=module` child that imports the real module by
// file:// URL (same technique as railway-db-url.spec.ts) and prints one JSON line.

const API_DIR = path.resolve(__dirname, "../..");
const LIB = pathToFileURL(path.resolve(API_DIR, "scripts/lib/backup-dump.mjs")).href;
const SCRIPT = path.resolve(API_DIR, "scripts/backup-production.mjs");

function run<T>(body: string, input: unknown = null): T {
  const code = `
    import * as lib from "${LIB}";
    const input = JSON.parse(process.env.BD_INPUT);
    const out = await (async () => { ${body} })();
    console.log(JSON.stringify(out));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, BD_INPUT: JSON.stringify(input) },
  });
  if (res.status !== 0) throw new Error(`child failed: ${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout.trim().split("\n").pop() as string);
}

const tableLines = (n: number) =>
  Array.from({ length: n }, (_, i) => `CREATE TABLE public."T${i}" (id text);`);

/** A minimal plain-format dump: tables, an unrelated COPY, then the migrations block. */
function dump({
  tables = 120,
  migrations = ["m1\tabc\t2026-01-01", "m2\tdef\t2026-01-02", "m3\tghi\t2026-01-03"],
  header = "COPY public._prisma_migrations (id, checksum, finished_at) FROM stdin;",
  eol = "\n",
  withMigrations = true,
}: {
  tables?: number;
  migrations?: string[];
  header?: string;
  eol?: string;
  withMigrations?: boolean;
} = {}) {
  const lines = [
    "-- PostgreSQL database dump",
    ...tableLines(tables),
    'COPY public."Tenant" (id, name) FROM stdin;',
    "t1\tacme",
    "t2\tglobex",
    "\\.",
    ...(withMigrations ? [header, ...migrations, "\\."] : []),
    "-- done",
  ];
  return lines.join(eol) + eol;
}

const scan = (text: string) =>
  run<{ lines: number; tables: number; copyBlocks: number; migrationRows: number }>(
    "return lib.scanDump(input.split('\\n'))",
    text,
  );

describe("scanDump", () => {
  it("counts the DATA rows in the unquoted _prisma_migrations block (the old prototype reported -1)", async () => {
    const s = scan(dump());
    expect(s.migrationRows).toBe(3);
    expect(s.tables).toBe(120);
    expect(s.copyBlocks).toBe(2);
  });

  it('also recognises a quoted COPY public."_prisma_migrations" header', () => {
    const s = scan(
      dump({ header: 'COPY public."_prisma_migrations" (id, checksum, finished_at) FROM stdin;' }),
    );
    expect(s.migrationRows).toBe(3);
  });

  it("does not count the header or the \\. terminator as rows, and ignores CRLF", () => {
    const s = scan(dump({ eol: "\r\n", migrations: ["only-one"] }));
    expect(s.migrationRows).toBe(1);
  });

  it("reports -1 when there is no _prisma_migrations block at all", () => {
    expect(scan(dump({ withMigrations: false })).migrationRows).toBe(-1);
  });

  it("reports 0 for an empty block", () => {
    expect(scan(dump({ migrations: [] })).migrationRows).toBe(0);
  });

  it("only counts CREATE TABLE public.* — indexes, views and comments do not inflate it", () => {
    const text = [
      "CREATE TABLE public.a (id int);",
      "CREATE TABLE other.b (id int);",
      "CREATE INDEX i ON public.a (id);",
      "-- CREATE TABLE public.c",
    ].join("\n");
    expect(scan(text).tables).toBe(1);
  });

  it("does not let another COPY block's rows leak into the migrations count", () => {
    const s = scan(dump({ migrations: ["m1"] }));
    expect(s.migrationRows).toBe(1); // Tenant's two rows are not migrations
  });
});

describe("dumpProblems", () => {
  const problems = (stats: object) => run<string[]>("return lib.dumpProblems(input)", stats);

  it("accepts a full-looking prod dump", () => {
    expect(problems({ tables: 125, migrationRows: 240 })).toEqual([]);
  });

  it("refuses 99 tables but accepts exactly 100", () => {
    expect(problems({ tables: 99, migrationRows: 5 })).toHaveLength(1);
    expect(problems({ tables: 100, migrationRows: 5 })).toEqual([]);
  });

  it("refuses a dump with no migrations block", () => {
    expect(problems({ tables: 125, migrationRows: -1 })[0]).toMatch(
      /no COPY public\._prisma_migrations/,
    );
  });

  it("refuses an empty migrations block, and reports every reason at once", () => {
    expect(problems({ tables: 125, migrationRows: 0 })[0]).toMatch(/0 rows/);
    expect(problems({ tables: 3, migrationRows: -1 })).toHaveLength(2);
  });
});

describe("buildPgDumpInvocation", () => {
  const env = {
    POSTGRES_USER: "postgres",
    POSTGRES_PASSWORD: "s3cr3t/pass word&",
    POSTGRES_DB: "railway",
    RAILWAY_TCP_PROXY_DOMAIN: "proxy.example.net",
    RAILWAY_TCP_PROXY_PORT: "12345",
  };
  const inv = () =>
    run<{ args: string[]; env: Record<string, string> }>(
      "return lib.buildPgDumpInvocation(input, '/tmp/x.sql')",
      env,
    );

  it("keeps the password off argv — it travels only in PGPASSWORD", () => {
    const { args, env: childEnv } = inv();
    expect(args.join(" ")).not.toContain("s3cr3t");
    expect(childEnv.PGPASSWORD).toBe(env.POSTGRES_PASSWORD);
    expect(args).toContain("--no-password");
  });

  it("targets the TCP proxy and writes plain, ACL/owner-free SQL to the file", () => {
    const { args } = inv();
    expect(args).toEqual(
      expect.arrayContaining([
        "-h",
        "proxy.example.net",
        "-p",
        "12345",
        "-U",
        "postgres",
        "-d",
        "railway",
        "--format=plain",
        "--no-acl",
        "--no-owner",
        "-f",
        "/tmp/x.sql",
      ]),
    );
  });

  it("defaults PGSSLMODE to prefer but honours an explicit value", () => {
    expect(inv().env.PGSSLMODE).toBe("prefer");
    const custom = run<{ env: Record<string, string> }>(
      "return lib.buildPgDumpInvocation({...input, PGSSLMODE: 'require'}, 'f')",
      env,
    );
    expect(custom.env.PGSSLMODE).toBe("require");
  });
});

describe("backupFileName", () => {
  const name = (label: unknown) =>
    run<string>("return lib.backupFileName(input, new Date(2026, 8, 19, 7, 5, 9))", label);

  it("is production_<ts>_<label>.sql in local time", () => {
    expect(name("pre-migration")).toBe("production_20260919_070509_pre-migration.sql");
  });

  it("strips path separators and shell metacharacters from the label", () => {
    expect(name("../../etc/pass wd;rm")).not.toMatch(/[\\/ ;]/);
  });

  it("falls back to 'manual' when there is no label", () => {
    expect(name(undefined)).toMatch(/_manual\.sql$/);
    expect(name("")).toMatch(/_manual\.sql$/);
  });
});

describe("findPgDump", () => {
  const find = (installed: string[], onPath: boolean, dirs: string[] | "throw") =>
    run<string | null>(
      `
      const { installed, onPath, dirs } = input;
      return lib.findPgDump({
        probe: (cmd) => (cmd === "pg_dump" ? onPath : installed.includes(cmd)),
        listDir: () => { if (dirs === "throw") throw new Error("ENOENT"); return dirs; },
        programFiles: "C:/PF",
      });`,
      { installed, onPath, dirs },
    );

  it("prefers a pg_dump on PATH", () => {
    expect(find([], true, ["16"])).toBe("pg_dump");
  });

  it("otherwise picks the NEWEST install numerically — 16 beats 9.6 (a lexical sort would not)", () => {
    const all = ["C:/PF/PostgreSQL/9.6/bin/pg_dump.exe", "C:/PF/PostgreSQL/16/bin/pg_dump.exe"];
    const norm = (s: string | null) => s?.replace(/\\/g, "/");
    expect(
      norm(
        find(
          all.map((p) => p.replace(/\//g, path.sep)),
          false,
          ["9.6", "16", "15"],
        ),
      ),
    ).toBe(all[1]);
  });

  it("skips an install dir whose pg_dump.exe is missing and takes the next newest", () => {
    const only15 = [path.join("C:/PF", "PostgreSQL", "15", "bin", "pg_dump.exe")];
    expect(find(only15, false, ["15", "16"])?.replace(/\\/g, "/")).toBe(
      "C:/PF/PostgreSQL/15/bin/pg_dump.exe",
    );
  });

  it("returns null when nothing is installed or the PostgreSQL dir does not exist", () => {
    expect(find([], false, [])).toBeNull();
    expect(find([], false, "throw")).toBeNull();
  });
});

describe("backup-production.mjs (no database is ever touched)", () => {
  it("fails closed with a usage message when the Railway proxy variables are absent", () => {
    const env = { ...process.env };
    for (const k of [
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "RAILWAY_TCP_PROXY_DOMAIN",
      "RAILWAY_TCP_PROXY_PORT",
    ]) {
      delete env[k];
    }
    const res = spawnSync(process.execPath, [SCRIPT, "unit-test"], { encoding: "utf8", env });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Missing env");
    expect(res.stderr).toContain("railway run --service postgres node");
  });
});
