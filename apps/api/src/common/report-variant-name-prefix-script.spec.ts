import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * B1: the owner-run, READ-ONLY census of variants whose stored name carries the parent prefix
 * (apps/api/scripts/report-variant-name-prefix.mjs). The classifier and summary are checked by its own
 * `--self-test` (no database); the argument gates refuse before any connection; a source pin keeps it write-free
 * and tenant-id-only.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/report-variant-name-prefix.mjs");

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env))
    if (
      k === "DATABASE_URL" ||
      k.startsWith("RAILWAY_") ||
      k.startsWith("POSTGRES_") ||
      k.startsWith("PG")
    )
      delete env[k];
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env,
    timeout: 60_000,
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

/** Source with // and block comments removed, so a word in prose never counts as a call. */
const code = (): string =>
  readFileSync(SCRIPT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("report-variant-name-prefix.mjs (B1)", () => {
  it("--self-test passes with no database", () => {
    const r = run(["--self-test"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/self-test ok/);
  });

  it.each([
    [["--apply"], /unknown argument --apply/],
    [["--tenant"], /--tenant needs a value/],
    [["--sample", "x"], /--sample needs a non-negative integer/],
    [["stray"], /unexpected argument stray/],
  ])("%j is refused (exit 2) before any connection", (args, message) => {
    const r = run(args);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(message);
    expect(r.out).not.toMatch(/ECONNREFUSED|ENOTFOUND|getaddrinfo/);
  });

  it("performs ZERO writes: Prisma only via product.findMany / product.count, in a read-only session", () => {
    const src = code();
    expect(src).toContain("default_transaction_read_only=on");
    // The only Prisma model calls are the two reads.
    const calls = [...src.matchAll(/prisma\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(new Set(calls)).toEqual(new Set(["product.findMany", "product.count"]));
    // No write verb of any spelling, no raw SQL, no transaction.
    expect(src).not.toMatch(
      /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$executeRaw|\$queryRaw|\$transaction|\$executeRawUnsafe|\$queryRawUnsafe/,
    );
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b\s+("|[A-Z])/);
  });

  it("names tenants by id only: it never reads a Tenant row, slug or business name", () => {
    const src = code();
    expect(src).not.toMatch(/prisma\.tenant\b|\bslug\b|businessName|isTestTenant/);
  });
});
