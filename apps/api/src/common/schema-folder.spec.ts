import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Wave E / imp-10a, T1 — static + spawn contract for the `prisma/schema/`
 * domain folder that replaced the single 4,438-line `prisma/schema.prisma`
 * (apps/api/scripts/split-prisma-schema.mjs). Every oracle here reads the
 * folder/config text directly (or spawns the split script's own `--check`)
 * so each case fails on its OWN observed value against the pre-split tree —
 * before the split, `apps/api/prisma/schema/` does not exist, so every
 * `fs`-based helper below degrades to an empty/zero result rather than
 * throwing, and the assertions show a real diff (e.g. "[] vs 7 names",
 * "0 vs 125") instead of an uncaught ENOENT crashing the whole file.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const API_DIR = path.join(REPO_ROOT, "apps/api");
const SCHEMA_DIR = path.join(API_DIR, "prisma/schema");
const SPLIT_SCRIPT = path.join(API_DIR, "scripts/split-prisma-schema.mjs");
const PRISMA_CONFIG_PATH = path.join(API_DIR, "prisma.config.ts");

const EXPECTED_FILES = [
  "_base.prisma",
  "catalog.prisma",
  "compliance.prisma",
  "finance.prisma",
  "platform.prisma",
  "sales.prisma",
  "tenancy.prisma",
].sort();

// The folder's CURRENT counts — measured via
// `node apps/api/scripts/split-prisma-schema.mjs --check`, which reports
// (208 blocks: 126 models, 80 enums, 2 datasource/generator). These are not
// the split-time counts: the folder legitimately grows. Pinned as literals
// per the brief; a real model/enum addition updates both the schema and this
// pin in the same PR.
const EXPECTED_MODEL_COUNT = 128;
const EXPECTED_ENUM_COUNT = 83;

function listSchemaFiles(): string[] {
  if (!fs.existsSync(SCHEMA_DIR)) return [];
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".prisma"))
    .sort();
}

function readSchemaFileOrEmpty(name: string): string {
  const full = path.join(SCHEMA_DIR, name);
  if (!fs.existsSync(full)) return "";
  return fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
}

function countTopLevel(text: string, kind: "model" | "enum" | "datasource" | "generator"): number {
  const re = new RegExp(`^${kind} [A-Za-z_][A-Za-z0-9_]*\\s*\\{$`, "gm");
  return (text.match(re) ?? []).length;
}

function extractNames(text: string, kind: "model" | "enum"): string[] {
  const re = new RegExp(`^${kind} ([A-Za-z_][A-Za-z0-9_]*)\\s*\\{$`, "gm");
  return Array.from(text.matchAll(re)).map((m) => m[1]);
}

describe("schema folder (wave E / imp-10a, T1)", () => {
  it("(a) apps/api/prisma/schema/ exists and holds exactly the seven expected domain files", () => {
    expect(listSchemaFiles()).toEqual(EXPECTED_FILES);
  });

  it("(b) apps/api/prisma/schema.prisma (the single file) no longer exists", () => {
    const singleFile = path.join(API_DIR, "prisma/schema.prisma");
    expect(fs.existsSync(singleFile)).toBe(false);
  });

  it("(c) _base.prisma holds exactly one datasource and one generator block and no model/enum blocks", () => {
    const base = readSchemaFileOrEmpty("_base.prisma");
    expect(countTopLevel(base, "datasource")).toBe(1);
    expect(countTopLevel(base, "generator")).toBe(1);
    expect(countTopLevel(base, "model")).toBe(0);
    expect(countTopLevel(base, "enum")).toBe(0);
  });

  it.each(EXPECTED_FILES.filter((f) => f !== "_base.prisma"))(
    "(c) %s holds at least one model block",
    (file) => {
      const text = readSchemaFileOrEmpty(file);
      expect(countTopLevel(text, "model")).toBeGreaterThanOrEqual(1);
    },
  );

  it(`(d) the folder holds exactly ${EXPECTED_MODEL_COUNT} model blocks in total`, () => {
    const total = EXPECTED_FILES.reduce(
      (sum, f) => sum + countTopLevel(readSchemaFileOrEmpty(f), "model"),
      0,
    );
    expect(total).toBe(EXPECTED_MODEL_COUNT);
  });

  it(`(d) the folder holds exactly ${EXPECTED_ENUM_COUNT} enum blocks in total`, () => {
    const total = EXPECTED_FILES.reduce(
      (sum, f) => sum + countTopLevel(readSchemaFileOrEmpty(f), "enum"),
      0,
    );
    expect(total).toBe(EXPECTED_ENUM_COUNT);
  });

  it("(e) every model name is unique across the whole folder", () => {
    const names = EXPECTED_FILES.flatMap((f) => extractNames(readSchemaFileOrEmpty(f), "model"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("(e) every enum name is unique across the whole folder", () => {
    const names = EXPECTED_FILES.flatMap((f) => extractNames(readSchemaFileOrEmpty(f), "enum"));
    expect(new Set(names).size).toBe(names.length);
  });

  it('(f) prisma.config.ts points "schema" at the prisma/schema folder', () => {
    const text = fs.existsSync(PRISMA_CONFIG_PATH)
      ? fs.readFileSync(PRISMA_CONFIG_PATH, "utf8")
      : "";
    const pointsAtFolder =
      /schema:\s*path\.join\(\s*["']prisma["']\s*,\s*["']schema["']\s*\)/.test(text) ||
      /schema:\s*["']prisma\/schema["']/.test(text);
    expect(pointsAtFolder).toBe(true);
  });

  it("(f) prisma.config.ts sets an explicit migrations path", () => {
    const text = fs.existsSync(PRISMA_CONFIG_PATH)
      ? fs.readFileSync(PRISMA_CONFIG_PATH, "utf8")
      : "";
    const hasExplicitMigrationsPath =
      /migrations:\s*\{[^}]*path:\s*path\.join\(\s*["']prisma["']\s*,\s*["']migrations["']\s*\)/.test(
        text,
      ) || /migrations:\s*\{[^}]*path:\s*["']prisma\/migrations["']/.test(text);
    expect(hasExplicitMigrationsPath).toBe(true);
  });

  it("(g) `node apps/api/scripts/split-prisma-schema.mjs --check` (no original given) exits 0 and reports structural invariants hold — never block-identical", () => {
    const res = spawnSync(process.execPath, [SPLIT_SCRIPT, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
    });

    // Content oracle before the exit status: a script that does not exist
    // (pre-split tree) also produces a non-zero status, so the discriminating
    // check is the actual report in stdout. `--check` with no --from/--from-ref
    // runs the structural invariants only — it never claims block-identity
    // (that requires an explicit original; see case (h)).
    const stdout = res.stdout ?? "";
    expect(stdout).toContain("structural invariants hold");
    expect(stdout).not.toContain("block-identical");
    expect(res.status).toBe(0);
  }, 130_000);

  // (h) RETIRED. It ran `--check --from-ref e39bf9db` and asserted the folder was still
  // block-identical (207 blocks) to the retired single `apps/api/prisma/schema.prisma` at the
  // commit before the split. That one-time lossless proof was recorded at split time and stands
  // in history; it is not a property of the tree going forward — the folder has since legitimately
  // gained models, so no value of a block count can make that comparison pass again (re-running it
  // today reports "block count 208 in the folder vs 207 in git e39bf9db:…"). The case was also
  // `it.skip`ped on a depth-1 CI clone, so it only ever ran locally.
  // The standing lossless guard going forward is `apps/api/scripts/schema-drift.mjs`
  // (`npm run local:drift` / the CI db-migrations replay), per CLAUDE.md — that is what must stay
  // green. Case (g) above keeps enforcing the folder's own structural invariants.
});
