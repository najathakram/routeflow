/**
 * T2 (R2) — static guard: no scheduled job in `apps/api/src` may use a bare `@Cron(`.
 *
 * Every tick must go through `@LeaderCron(expr, "<area>.<method>")` so exactly one replica runs
 * it (`apps/api/src/common/cron-lock.ts`). This walks the tree instead of asserting per file, so
 * a NEW bare `@Cron(` added anywhere fails here rather than duplicating silently in production.
 *
 * Excluded: `*.spec.ts` (they contain both literals as data) and `common/cron-lock.ts` (it is the
 * only legitimate `Cron` call site).
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..");
const CRON_LOCK = path.join(SRC_ROOT, "common", "cron-lock.ts");

/** Every `@LeaderCron` job name, exactly as spec R2 lists them. */
const EXPECTED_NAMES = [
  "authorization-expiry.runExpirySweep",
  "billing-cron.expireTrials",
  "billing-cron.expireGrace",
  "billing-cron.applyScheduledDowngrades",
  "billing-cron.applyScheduledCancellations",
  "billing-cron.rollCycles",
  "billing.suspendOverdueTenants",
  "order-templates.generateDailyOrders",
  "orders.cronSweepPendingOrders",
  "recurring-invoices.generateDueRecurringInvoices",
  "regulated-filing.autoPrepareClosedFilings",
  "commission-reconciliation.reconcileCommissions",
  "tobacco-report.generateMonthlyReports",
].sort();

function collectSourceFiles(dir: string, out: string[] = [], includeSpecs = false): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectSourceFiles(full, out, includeSpecs);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (!includeSpecs && entry.name.endsWith(".spec.ts")) continue;
    if (full === CRON_LOCK) continue;
    out.push(full);
  }
  return out;
}

const FILES = collectSourceFiles(SRC_ROOT);
// The IMPORT guard below is deliberately wider than the decorator guard: it keeps spec files in,
// because a spec that imports `Cron` can register a real, un-elected job inside a testing module.
const FILES_WITH_SPECS = collectSourceFiles(SRC_ROOT, [], true);
// `@LeaderCron(` does NOT contain `@Cron(` — the character before `Cron(` is `r` — so this
// pattern counts bare decorators only.
const BARE_CRON = /@Cron\(/g;
const LEADER_CRON = /@LeaderCron\(/g;
// Multi-line tolerant: prettier wraps a long site across lines and adds a trailing comma
// (`recurring-invoices.generateDueRecurringInvoices`), so whitespace spans and the `,?` matter.
const LEADER_CRON_SITE =
  /@LeaderCron\(\s*(?:"[^"]*"|CronExpression\.[A-Z_]+)\s*,\s*"([^"]+)"\s*,?\s*\)/g;

function countMatches(text: string, re: RegExp): number {
  return text.match(new RegExp(re.source, "g"))?.length ?? 0;
}

// Named-import list of any `@nestjs/schedule` import, e.g. `import { Cron, type CronOptions } from
// "@nestjs/schedule"`. `[^}]*` spans newlines, so a prettier-wrapped list is captured whole.
const SCHEDULE_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@nestjs\/schedule["']/;

/** Every identifier named-imported from `@nestjs/schedule`, `type` and `as` aliases resolved. */
function scheduleImportSpecifiers(text: string): string[] {
  const names: string[] = [];
  const re = new RegExp(SCHEDULE_IMPORT.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (const raw of m[1].split(",")) {
      // `type Cron` and `Cron as X` both still bring `Cron` in — the IMPORTED name is what
      // matters, not the local binding, so take the first identifier of each specifier.
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) names.push(name);
    }
  }
  return names;
}

describe("no bare @Cron in apps/api/src (T2, R2)", () => {
  const sources = FILES.map((file) => ({
    file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"),
    text: fs.readFileSync(file, "utf8"),
  }));

  it("walks a non-trivial number of source files (guards against an empty scan reporting green)", () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it("has zero bare `@Cron(` decorators", () => {
    const offenders = sources
      .filter((s) => countMatches(s.text, BARE_CRON) > 0)
      .map((s) => `${s.file} (${countMatches(s.text, BARE_CRON)})`);

    expect(offenders).toEqual([]);
  });

  it("has exactly 13 `@LeaderCron(` sites, every one of them well-formed", () => {
    const declared = sources.reduce((n, s) => n + countMatches(s.text, LEADER_CRON), 0);
    const wellFormed = sources.reduce((n, s) => n + countMatches(s.text, LEADER_CRON_SITE), 0);

    expect(declared).toBe(13);
    // A site that does not match the full `(expr, "name")` shape would be invisible to the name
    // assertions below, so pin the two counts together.
    expect(wellFormed).toBe(declared);
  });

  describe("the `Cron` identifier is imported in exactly one place", () => {
    // Stronger than the decorator scan: a bare `@Cron(` is the visible symptom, but the IMPORT is
    // the capability. A file that pulls `Cron` in can also apply it indirectly (aliased, or via
    // `applyDecorators`), which `BARE_CRON` would never see. `CronExpression` and `ScheduleModule`
    // are ordinary imports and stay allowed.
    const specImports = FILES_WITH_SPECS.map((file) => ({
      file: path.relative(SRC_ROOT, file).replace(/\\/g, "/"),
      names: scheduleImportSpecifiers(fs.readFileSync(file, "utf8")),
    }));

    it("parses named imports from @nestjs/schedule at all (a regex matching nothing would report green)", () => {
      // The two identifiers the app legitimately imports today — if neither is found, the parser
      // is broken and the offender assertion below is meaningless.
      const all = new Set(specImports.flatMap((s) => s.names));
      expect(all.has("CronExpression")).toBe(true);
      expect(all.has("ScheduleModule")).toBe(true);
      // And it must genuinely see `Cron` where it IS imported: `common/cron-lock.ts`, the one file
      // excluded from this scan.
      expect(scheduleImportSpecifiers(fs.readFileSync(CRON_LOCK, "utf8"))).toContain("Cron");
    });

    it("has no file other than common/cron-lock.ts importing `Cron` from @nestjs/schedule", () => {
      const offenders = specImports.filter((s) => s.names.includes("Cron")).map((s) => s.file);

      expect(offenders).toEqual([]);
    });
  });

  it("registers the 13 expected job names, all unique", () => {
    const names: string[] = [];
    for (const s of sources) {
      const re = new RegExp(LEADER_CRON_SITE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(s.text)) !== null) names.push(m[1]);
    }

    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(EXPECTED_NAMES);
  });
});
