/**
 * SA-738 / SA-738r (L-167 class) — structural pin: the tenant's time zone is READ in exactly one place.
 *
 * `common/tenant-time-zone.ts` is the one resolver (`resolveZone`, `zoneFromConfig`,
 * `resolveTenantZone`, `tenantTimeZone`). A second reader is how three divergent fallbacks shipped
 * (GET /settings -> New York, the low-stock digest -> New York, everything else -> UTC), so this walks
 * `apps/api/src` and fails when a non-spec file:
 *   1. selects the column with a literal `timezone: true` (a batched read spreads the resolver's
 *      `TENANT_ZONE_SELECT` instead),
 *   2. reads `.timezone` off a tenant-config-shaped value (`cfg`, `config`, `tenantConfig`),
 *   3. calls `resolveZone(...)` with anything but a context OBJECT as its second argument, or passes
 *      `tenantTimeZone(...)` a bare positional tenant id (SA-738r: no positional tenantId, so a
 *      per-location zone is a compile-safe, small diff).
 *
 * Allow-list: the resolver itself and the WRITER of the zone (it reads the old value for the audit
 * row). Nothing else. Style: `no-bare-cron.spec.ts`.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const rel = (f: string) => path.relative(SRC_ROOT, f).split(path.sep).join("/");

/** The ONLY files that may touch the stored zone: the resolver and the writer. */
const READ_ALLOW_LIST = new Set([
  "common/tenant-time-zone.ts",
  "system-config/tenant-timezone.writer.ts",
]);

const SELECT_READ = /\btimezone\s*:\s*true\b/;
const CONFIG_PROPERTY_READ = /\b(?:cfg|config|tenantConfig|tenantCfg)\s*\??\.\s*timezone\b/;
/** In a file that touches TenantConfig / the zone select: the other ways to pull the column out. */
const DESTRUCTURED_READ = /\{[^{}]*\btimezone\b[^{}]*\}\s*=(?![=>])/;
const NON_NULL_READ = /!\s*\.\s*timezone\b/;
const QUOTED_KEY_READ = /["'`]timezone["'`]/;
const TOUCHES_TENANT_CONFIG = /\btenantConfig\b|\bTENANT_ZONE_SELECT\b/;
/** `zoneFromConfig(<row>, {` / `configuredZone(<row>, {`: the row plus a ZoneContext object. */
const FROM_CONFIG_CALL = /\b(?:zoneFromConfig|configuredZone)\s*\(/g;
const FROM_CONFIG_OK = /\b(?:zoneFromConfig|configuredZone)\s*\(\s*[\w.?]+\s*,\s*\{/;
/** `resolveZone(<prisma>, {` is the only accepted call shape. */
const RESOLVE_ZONE_CALL = /\bresolveZone\s*\(/g;
const RESOLVE_ZONE_OK = /\bresolveZone\s*\(\s*[\w.]+\s*,\s*\{/;
/** `tenantTimeZone(<prisma>, <anything but an object literal>)` is a positional tenant id. */
const POSITIONAL_TENANT_ID = /\btenantTimeZone\s*\(\s*[\w.]+\s*,\s*(?!\{)\S/;

/** Source text with comments blanked, so a doc comment never counts as a read. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\/\/.*$/gm, "");
}

function violationsIn(file: string, source: string): string[] {
  const out: string[] = [];
  const code = stripComments(source);
  if (!READ_ALLOW_LIST.has(file)) {
    if (SELECT_READ.test(code))
      out.push(`${file}: selects tenant-config \`timezone: true\` directly`);
    if (CONFIG_PROPERTY_READ.test(code))
      out.push(`${file}: reads \`.timezone\` off a tenant config`);
    if (TOUCHES_TENANT_CONFIG.test(code)) {
      if (DESTRUCTURED_READ.test(code)) out.push(`${file}: destructures \`timezone\` off a config`);
      if (NON_NULL_READ.test(code)) out.push(`${file}: reads \`!.timezone\``);
      if (QUOTED_KEY_READ.test(code)) out.push(`${file}: reads a quoted "timezone" key`);
    }
  }
  if (file !== "common/tenant-time-zone.ts") {
    for (const m of code.matchAll(RESOLVE_ZONE_CALL)) {
      const from = code.slice(m.index);
      if (!RESOLVE_ZONE_OK.test(from.slice(0, 120))) {
        out.push(`${file}: resolveZone called without a context object`);
      }
    }
    for (const m of code.matchAll(FROM_CONFIG_CALL)) {
      if (!FROM_CONFIG_OK.test(code.slice(m.index, m.index + 120))) {
        out.push(`${file}: zoneFromConfig/configuredZone called without a ZoneContext object`);
      }
    }
    if (POSITIONAL_TENANT_ID.test(code)) {
      out.push(`${file}: tenantTimeZone called with a positional tenant id`);
    }
  }
  return out;
}

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collect(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(spec|test)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = collect(SRC_ROOT);

describe("SA-738r: the tenant time zone has ONE reader (common/tenant-time-zone.ts)", () => {
  it("scanned a real source tree (guards a path typo turning the scan vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    for (const f of READ_ALLOW_LIST) expect(fs.existsSync(path.join(SRC_ROOT, f))).toBe(true);
  });

  it("no source file outside the resolver and the writer reads the stored zone", () => {
    const bad = FILES.flatMap((f) => violationsIn(rel(f), fs.readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("every resolveZone caller passes the context object, none passes a positional tenant id", () => {
    const callers = FILES.filter((f) => /\bresolveZone\s*\(/.test(fs.readFileSync(f, "utf8"))).map(
      rel,
    );
    // the migrated sites: settings counter window, sales facts, analytics, billing notice, overdue sweep, regulated report
    expect(callers).toEqual(
      expect.arrayContaining([
        "orders/counter-sale/counter-sale-today.service.ts",
        "sales-facts/sales-facts.service.ts",
        "analytics/analytics.service.ts",
        "billing/billing-notification.service.ts",
        "invoices/overdue-sweep.service.ts",
        "regulated/regulated-report.service.ts",
      ]),
    );
  });

  it("the raw-config call sites pass a ZoneContext object too (the low-stock digest is the documented batched-read exception)", () => {
    const callers = FILES.filter((f) =>
      /\b(?:zoneFromConfig|configuredZone)\s*\(/.test(fs.readFileSync(f, "utf8")),
    )
      .map(rel)
      .filter((f) => f !== "common/tenant-time-zone.ts");
    expect(callers.sort()).toEqual([
      "inventory/low-stock-digest.service.ts",
      "invoices/invoices.service.ts",
      "system-config/settings.controller.ts",
    ]);
  });

  it("the allow-list is exactly the resolver and the writer (it never grows by accident)", () => {
    expect([...READ_ALLOW_LIST].sort()).toEqual([
      "common/tenant-time-zone.ts",
      "system-config/tenant-timezone.writer.ts",
    ]);
  });
});

describe("the scanner itself (planted violations)", () => {
  it("flags a direct select of the column", () => {
    const src =
      "const c = await prisma.tenantConfig.findUnique({ where, select: { timezone: true } });";
    expect(violationsIn("x/y.service.ts", src)).toHaveLength(1);
  });

  it("flags a nested select and a property read", () => {
    const src =
      "select: { config: { select: { timezone: true } } }; const z = cfg?.timezone ?? null;";
    expect(violationsIn("x/y.service.ts", src)).toHaveLength(2);
  });

  it("does not flag the resolver's own helpers or a comment", () => {
    const src = [
      "// reads timezone: true once",
      "select: { ...TENANT_ZONE_SELECT, businessName: true },",
      "const { zone } = zoneFromConfig(config, { tenantId });",
    ].join("\n");
    expect(violationsIn("x/y.service.ts", src)).toEqual([]);
  });

  it("flags a resolveZone call without a context object", () => {
    expect(violationsIn("x/y.service.ts", 'await resolveZone(this.prisma, "t1");')).toHaveLength(1);
    expect(violationsIn("x/y.service.ts", "await resolveZone(this.prisma, { tenantId });")).toEqual(
      [],
    );
  });

  it("flags a positional tenant id on tenantTimeZone but allows the ambient call and the object form", () => {
    expect(
      violationsIn("x/y.service.ts", "await tenantTimeZone(this.prisma, tenantId);"),
    ).toHaveLength(1);
    expect(violationsIn("x/y.service.ts", "await tenantTimeZone(this.prisma);")).toEqual([]);
    expect(
      violationsIn("x/y.service.ts", "await tenantTimeZone(this.prisma, { tenantId });"),
    ).toEqual([]);
  });

  it("flags destructuring, a non-null read and a quoted key in a file that touches TenantConfig", () => {
    const touch = "const c = await prisma.tenantConfig.findUnique({ where });\n";
    expect(violationsIn("x/y.service.ts", touch + "const { timezone } = c;")).toHaveLength(1);
    expect(violationsIn("x/y.service.ts", touch + "const { a, timezone: z } = c!;")).toHaveLength(
      1,
    );
    expect(violationsIn("x/y.service.ts", touch + "const z = c!.timezone;")).toHaveLength(1);
    expect(violationsIn("x/y.service.ts", touch + 'const z = c["timezone"];')).toHaveLength(1);
    expect(violationsIn("x/y.service.ts", touch + "const z = c['timezone'];")).toHaveLength(1);
  });

  it("does not flag those shapes in a file that never touches TenantConfig", () => {
    expect(violationsIn("x/y.service.ts", "const { timezone } = messagingRow;")).toEqual([]);
  });

  it("flags zoneFromConfig / configuredZone without a context object, allows the object form", () => {
    expect(violationsIn("x/y.service.ts", "zoneFromConfig(cfg, tenantId);")).toHaveLength(1);
    expect(violationsIn("x/y.service.ts", "configuredZone(cfg);")).toHaveLength(1);
    expect(violationsIn("x/y.service.ts", "zoneFromConfig(cfg, { tenantId });")).toEqual([]);
    expect(violationsIn("x/y.service.ts", "configuredZone(cfg, { tenantId });")).toEqual([]);
  });

  it("allows the allow-listed files to read the column", () => {
    expect(violationsIn("common/tenant-time-zone.ts", "select: { timezone: true }")).toEqual([]);
    expect(
      violationsIn("system-config/tenant-timezone.writer.ts", "const p = cfg?.timezone;"),
    ).toEqual([]);
  });
});
