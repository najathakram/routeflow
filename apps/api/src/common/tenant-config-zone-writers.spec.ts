/**
 * SA-1067 Z3 (L-167 class) — structural pin: a tenant's time zone is never stored by accident.
 *
 * A `TenantConfig` row created without naming `timezone` takes the column default (America/New_York), which nobody chose: the
 * tenant's day then moves with no audit row. So this walks the API source, the seeds and the scripts and fails when:
 *   1. a `tenantConfig.create(` / `tenantConfig.upsert(` argument does not name `timezone`
 *      (`tenant-timezone.writer.ts` is on the allow-list: its `data` carries the zone),
 *   2. a `tenant.create(` / `tenant.upsert(` in `apps/api/src` sits in a file that creates no `tenantConfig`.
 *
 * Companion to `tenant-zone-single-reader.spec.ts` (one READER); this is the WRITERS. Style: `no-bare-cron.spec.ts`.
 */
import * as fs from "fs";
import * as path from "path";

const API_ROOT = path.resolve(__dirname, "..", "..");
const SRC_ROOT = path.join(API_ROOT, "src");
const rel = (f: string) => path.relative(API_ROOT, f).split(path.sep).join("/");

/** The ONLY file whose config write is allowed to carry the zone in a variable (`data`) instead of naming it. */
const WRITER_ALLOW_LIST = new Set(["src/system-config/tenant-timezone.writer.ts"]);

/** Source text with comments blanked, so a doc comment that says "timezone" never counts as naming it. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The text of each `<name>(...)` call, balanced across lines. */
function callsOf(code: string, name: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(name.source + "\\s*\\(", "g");
  for (let m = re.exec(code); m; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    out.push(code.slice(m.index, i));
  }
  return out;
}

const CONFIG_WRITE = /\btenantConfig\s*\.\s*(?:create|upsert)/;
const CONFIG_UPSERT = /\btenantConfig\s*\.\s*upsert/;
const TENANT_WRITE = /\btenant\s*\.\s*(?:create|upsert)\b/;
const NAMES_ZONE = /\btimezone\b/;

/** The expression after `key:` in a call (balanced across ( [ {), up to the comma or close that ends it; "" when absent. */
function valueOf(call: string, key: string): string {
  const m = new RegExp("\\b" + key + "\\s*:").exec(call);
  if (!m) return "";
  let depth = 0;
  const start = m.index + m[0].length;
  let i = start;
  for (; i < call.length; i++) {
    const c = call[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return call.slice(start, i);
}

/**
 * A create names the zone in its data. An upsert must name it in its `create` block (a zone found only in `update` leaves the
 * insert on the column default), and must NOT name it in `update` (a re-run would move a zone somebody chose).
 */
export function configWritesWithoutZone(file: string, source: string): string[] {
  if (WRITER_ALLOW_LIST.has(file)) return [];
  const out: string[] = [];
  for (const c of callsOf(stripComments(source), CONFIG_WRITE)) {
    const head = c.split("\n")[0].trim();
    if (!CONFIG_UPSERT.test(c)) {
      if (!NAMES_ZONE.test(c)) out.push(`${file}: ${head} names no timezone`);
      continue;
    }
    if (!NAMES_ZONE.test(valueOf(c, "create")))
      out.push(`${file}: ${head} create names no timezone`);
    if (NAMES_ZONE.test(valueOf(c, "update")))
      out.push(`${file}: ${head} update names a timezone (a re-run would move a chosen zone)`);
  }
  return out;
}

export function tenantWritesWithoutConfig(file: string, source: string): string[] {
  const code = stripComments(source);
  if (callsOf(code, TENANT_WRITE).length === 0) return [];
  return CONFIG_WRITE.test(code) ? [] : [`${file}: creates a tenant but never a tenantConfig`];
}

function collect(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "testing") continue;
      collect(full, keep, out);
    } else if (keep(full)) out.push(full);
  }
  return out;
}
const isCode = (f: string) =>
  /\.(?:[cm]?js|ts)$/.test(f) && !/\.(?:spec|test)\.[cm]?[jt]s$/.test(f);

const SRC_FILES = collect(SRC_ROOT, (f) => isCode(f));
const SEEDS = fs
  .readdirSync(path.join(API_ROOT, "prisma"))
  .filter((n) => /^seed.*\.ts$/.test(n))
  .map((n) => path.join(API_ROOT, "prisma", n));
const SCRIPTS = collect(path.join(API_ROOT, "scripts"), (f) => isCode(f));
const ALL = [...SRC_FILES, ...SEEDS, ...SCRIPTS];

describe("SA-1067 Z3: every TenantConfig write names the zone", () => {
  it("scanned a real tree (guards a path typo turning the scan vacuous)", () => {
    expect(SRC_FILES.length).toBeGreaterThan(300);
    expect(SEEDS.length).toBeGreaterThan(0);
    expect(SCRIPTS.length).toBeGreaterThan(50);
    for (const f of WRITER_ALLOW_LIST) expect(fs.existsSync(path.join(API_ROOT, f))).toBe(true);
  });

  it("no tenantConfig.create / upsert argument leaves the zone to the column default", () => {
    const bad = ALL.flatMap((f) => configWritesWithoutZone(rel(f), fs.readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("every tenant.create / upsert in apps/api/src sits in a file that creates a tenantConfig", () => {
    const bad = SRC_FILES.flatMap((f) =>
      tenantWritesWithoutConfig(rel(f), fs.readFileSync(f, "utf8")),
    );
    expect(bad).toEqual([]);
  });

  it("the allow-list is exactly the zone writer (it never grows by accident)", () => {
    expect([...WRITER_ALLOW_LIST]).toEqual(["src/system-config/tenant-timezone.writer.ts"]);
  });
});

describe("Z-8 self-test: the scanner goes red on planted violations and stays green on good code", () => {
  it("flags a tenantConfig.create with no zone, and an upsert whose create names none", () => {
    expect(
      configWritesWithoutZone(
        "x.ts",
        'await prisma.tenantConfig.create({ data: { tenantId, businessName: "A" } });',
      ),
    ).toHaveLength(1);
    expect(
      configWritesWithoutZone(
        "x.ts",
        "await db.tenantConfig.upsert({\n  where: { tenantId },\n  create: { tenantId, ...configUpdate },\n  update: configUpdate,\n});",
      ),
    ).toHaveLength(1);
  });

  it("a zone found only in `update` is a violation: the insert still takes the column default", () => {
    expect(
      configWritesWithoutZone(
        "x.ts",
        "await db.tenantConfig.upsert({ where: { tenantId }, create: { tenantId }, update: { timezone: z } });",
      ),
    ).toHaveLength(2);
  });

  it("a seed whose `update` names the zone is a violation (a re-seed would overwrite a chosen zone); `update: {}` passes", () => {
    const seed = (update: string) =>
      `await prisma.tenantConfig.upsert({ where: { tenantId }, update: ${update}, create: { tenantId, timezone: "America/New_York" } });`;
    expect(
      configWritesWithoutZone("prisma/seed.ts", seed('{ timezone: "America/New_York" }')),
    ).toHaveLength(1);
    expect(configWritesWithoutZone("prisma/seed.ts", seed("{}"))).toEqual([]);
  });

  it("passes writes that name the zone, in any key position, and ignores a comment that only says the word", () => {
    expect(
      configWritesWithoutZone(
        "x.ts",
        "await db.tenantConfig.upsert({\n  where: { tenantId },\n  create: { tenantId, timezone: FALLBACK_ZONE, ...configUpdate },\n  update: configUpdate,\n});",
      ),
    ).toEqual([]);
    expect(
      configWritesWithoutZone(
        "x.ts",
        "// timezone is set later\nawait db.tenantConfig.create({ data: { tenantId } });",
      ),
    ).toHaveLength(1);
  });

  it("a tenantConfig read, or a longer name, is not a write", () => {
    expect(configWritesWithoutZone("x.ts", "await db.tenantConfig.findUnique({ where });")).toEqual(
      [],
    );
    expect(
      configWritesWithoutZone("x.ts", "await db.tenantConfigAudit.create({ data: {} });"),
    ).toEqual([]);
  });

  it("flags a tenant.create in a file with no tenantConfig, passes one that also creates the row", () => {
    expect(
      tenantWritesWithoutConfig("x.ts", "await tx.tenant.create({ data: { slug } });"),
    ).toHaveLength(1);
    expect(
      tenantWritesWithoutConfig(
        "x.ts",
        "await tx.tenant.create({ data: { slug } });\nawait tx.tenantConfig.create({ data: { tenantId, timezone } });",
      ),
    ).toEqual([]);
    expect(tenantWritesWithoutConfig("x.ts", "await tx.tenant.findFirst({ where });")).toEqual([]);
  });

  it("the writer allow-list passes a config write that carries the zone in a variable", () => {
    expect(
      configWritesWithoutZone(
        "src/system-config/tenant-timezone.writer.ts",
        "await tx.tenantConfig.upsert({ where, create: { tenantId, ...data }, update: data });",
      ),
    ).toEqual([]);
  });
});
