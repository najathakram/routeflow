import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { TENANT_JOB_CLASSES, TENANT_JOBS, type TenantJobSpec } from "./tenant-automation";

/**
 * SA-776 job pin (row 382): EVERY `@LeaderCron` job and Bull `@Process` handler under apps/api/src is classified in
 * `TENANT_JOBS`, and the class is honoured in the source. Read with the TypeScript compiler API (decorator nodes,
 * identifier references, property assignments), never a regex over file text (L-205).
 *
 *  - unclassified job (or a registry row for a job that no longer exists) -> fail;
 *  - TRANSACTIONAL -> the file references `acceptsAutomatedWrites` / `AUTOMATED_WRITE_STATUSES`, or (a reasoned
 *    GAP-5 row) keeps a literal `status: "ACTIVE"` filter;
 *  - RECORD_KEEPING -> the file references `acceptsRecordKeeping` / `RECORD_KEEPING_EXCLUDED_STATUSES`, or the row
 *    is an explicit, reasoned `NONE`.
 */
const SRC = path.resolve(__dirname, "..");

interface FoundJob {
  name: string;
  /** Path relative to apps/api/src, forward slashes. */
  file: string;
  kind: "cron" | "process";
}

function stringOf(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function decoratorCall(d: ts.Decorator): { name: string; args: readonly ts.Expression[] } | null {
  const e = d.expression;
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return null;
  return { name: e.expression.text, args: e.arguments };
}

/** Every job declared in one source text: `@LeaderCron(expr, "name")` and `@Processor("q")` + `@Process("name")`. */
export function jobsInSource(file: string, text: string): FoundJob[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: FoundJob[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node)) {
      let queue: string | null = null;
      for (const d of ts.getDecorators(node) ?? []) {
        const c = decoratorCall(d);
        if (c?.name === "Processor") queue = stringOf(c.args[0]);
      }
      for (const m of node.members) {
        if (!ts.isMethodDeclaration(m)) continue;
        for (const d of ts.getDecorators(m) ?? []) {
          const c = decoratorCall(d);
          if (!c) continue;
          if (c.name === "LeaderCron") {
            const name = stringOf(c.args[1]);
            out.push({ name: name ?? `<unnamed @LeaderCron in ${file}>`, file, kind: "cron" });
          } else if (c.name === "Process") {
            let n = stringOf(c.args[0]);
            const first = c.args[0];
            if (!n && first && ts.isObjectLiteralExpression(first)) {
              for (const p of first.properties) {
                if (
                  ts.isPropertyAssignment(p) &&
                  ts.isIdentifier(p.name) &&
                  p.name.text === "name"
                ) {
                  n = stringOf(p.initializer);
                }
              }
            }
            out.push({
              name: `${queue ?? "<queue>"}.${n ?? "__default"}`,
              file,
              kind: "process",
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** True when `text` uses one of `names` as an identifier outside an import (a real reference, not a comment). */
export function referencesAny(text: string, names: readonly string[]): boolean {
  const sf = ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && names.includes(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** True when the source has a `status: "ACTIVE"` property assignment (or `TenantStatus.ACTIVE`). */
export function hasActiveOnlyFilter(text: string): boolean {
  const sf = ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "status") ||
        stringOf(node.name) === "status")
    ) {
      let init = node.initializer;
      while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (stringOf(init) === "ACTIVE") found = true;
      if (
        ts.isPropertyAccessExpression(init) &&
        init.name.text === "ACTIVE" &&
        ts.isIdentifier(init.expression) &&
        init.expression.text === "TenantStatus"
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "testing") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts") && !e.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

export function allJobs(): FoundJob[] {
  return walk(SRC).flatMap((f) =>
    jobsInSource(path.relative(SRC, f).split(path.sep).join("/"), fs.readFileSync(f, "utf8")),
  );
}

/** The pin itself, pure over (found jobs, registry, a source reader) so the red proofs exercise the shipped logic. */
export function checkJobs(
  jobs: readonly FoundJob[],
  registry: Readonly<Record<string, TenantJobSpec>>,
  read: (file: string) => string | null,
): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const j of jobs) {
    if (names.has(j.name)) problems.push(`${j.name}: declared twice`);
    names.add(j.name);
    const spec = registry[j.name];
    if (!spec) {
      problems.push(
        `${j.name} (${j.file}): UNCLASSIFIED - add it to TENANT_JOBS in tenant/tenant-automation.ts`,
      );
      continue;
    }
    const where = spec.filterFile ?? j.file;
    const text = read(where);
    const ctx = `${j.name} [${spec.class}/${spec.filter}]`;
    if (!spec.reason || spec.reason.trim() === "") problems.push(`${ctx}: empty reason`);
    if (text === null) {
      problems.push(`${ctx}: filter file ${where} does not exist`);
      continue;
    }
    switch (spec.class) {
      case "TRANSACTIONAL":
        if (spec.filter === "AUTOMATED_WRITES") {
          if (!referencesAny(text, ["acceptsAutomatedWrites", "AUTOMATED_WRITE_STATUSES"])) {
            problems.push(
              `${ctx}: ${where} never references acceptsAutomatedWrites / AUTOMATED_WRITE_STATUSES`,
            );
          }
        } else if (spec.filter === "ACTIVE_ONLY") {
          if (!hasActiveOnlyFilter(text)) {
            problems.push(`${ctx}: ${where} has no \`status: "ACTIVE"\` filter`);
          }
        } else {
          problems.push(
            `${ctx}: a TRANSACTIONAL job must filter AUTOMATED_WRITES or be a reasoned ACTIVE_ONLY`,
          );
        }
        break;
      case "RECORD_KEEPING":
        if (spec.filter === "RECORD_KEEPING") {
          if (!referencesAny(text, ["acceptsRecordKeeping", "RECORD_KEEPING_EXCLUDED_STATUSES"])) {
            problems.push(
              `${ctx}: ${where} never references acceptsRecordKeeping / RECORD_KEEPING_EXCLUDED_STATUSES`,
            );
          }
        } else if (spec.filter !== "NONE") {
          problems.push(
            `${ctx}: a RECORD_KEEPING job must skip SUSPENDED / CANCELLED or say why it does not`,
          );
        }
        break;
      default:
        if (spec.filter !== "NONE")
          problems.push(`${ctx}: ${spec.class} jobs carry no tenant-status filter`);
    }
  }
  for (const name of Object.keys(registry)) {
    if (!names.has(name))
      problems.push(
        `${name}: in TENANT_JOBS but no such @LeaderCron / @Process job exists (dead row)`,
      );
  }
  return problems;
}

const reader = (file: string): string | null => {
  const full = path.join(SRC, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
};

describe("SA-776 job pin: every cron and queue processor is classified", () => {
  const found = allJobs();

  it("finds the whole job surface (an empty scan must not report green)", () => {
    expect(found.filter((j) => j.kind === "cron").length).toBeGreaterThanOrEqual(35);
    expect(found.filter((j) => j.kind === "process").map((j) => j.name)).toContain(
      "invoices.generate-invoice",
    );
  });

  it("classifies every job and honours its class in the source", () => {
    const problems = checkJobs(found, TENANT_JOBS, reader);
    expect(problems).toEqual([]);
  });

  it("TENANT_JOB_CLASSES is exactly { jobName: class } over the registry", () => {
    expect(Object.keys(TENANT_JOB_CLASSES).sort()).toEqual(Object.keys(TENANT_JOBS).sort());
    for (const v of Object.values(TENANT_JOB_CLASSES)) {
      expect(["TRANSACTIONAL", "RECORD_KEEPING", "HOUSEKEEPING", "PLATFORM"]).toContain(v);
    }
  });

  it("the ACTIVE-only crons are exactly the documented GAP-5 rows plus authorization-expiry (not silently re-filtered)", () => {
    const activeOnly = Object.entries(TENANT_JOBS)
      .filter(([, s]) => s.filter === "ACTIVE_ONLY")
      .map(([n]) => n)
      .sort();
    expect(activeOnly).toEqual([
      "authorization-expiry.runExpirySweep",
      "commission-reconciliation.reconcileCommissions",
      "order-templates.generateDailyOrders",
      "recurring-invoices.generateDueRecurringInvoices",
      "tobacco-report.generateMonthlyReports",
    ]);
  });
});

describe("SA-776 job pin: red proofs on fixture sources", () => {
  const FIXTURE_UNCLASSED = `
    import { LeaderCron } from "../common/cron-lock";
    export class Fixture {
      @LeaderCron("0 * * * *", "fixture.unclassedJob")
      async run() {}
    }`;
  const FIXTURE_TX_NO_PREDICATE = `
    import { LeaderCron } from "../common/cron-lock";
    export class Fixture {
      @LeaderCron("0 * * * *", "fixture.writesEverywhere")
      async run() { await this.prisma.tenant.findMany({}); }
    }`;
  const FIXTURE_TX_WITH_PREDICATE = `
    import { LeaderCron } from "../common/cron-lock";
    import { acceptsAutomatedWrites } from "../tenant/tenant-automation";
    export class Fixture {
      @LeaderCron("0 * * * *", "fixture.writesEverywhere")
      async run() { return acceptsAutomatedWrites("ACTIVE"); }
    }`;
  const FIXTURE_PROCESS = `
    @Processor("q")
    export class P {
      @Process("do-it")
      async handle() {}
    }`;
  const spec = (over: Partial<TenantJobSpec>): TenantJobSpec => ({
    class: "TRANSACTIONAL",
    filter: "AUTOMATED_WRITES",
    reason: "fixture",
    ...over,
  });
  const readAs = (text: string) => () => text;

  it("an unclassified @LeaderCron FAILS", () => {
    const jobs = jobsInSource("fixture.ts", FIXTURE_UNCLASSED);
    expect(jobs.map((j) => j.name)).toEqual(["fixture.unclassedJob"]);
    expect(checkJobs(jobs, {}, readAs(FIXTURE_UNCLASSED)).join("\n")).toMatch(/UNCLASSIFIED/);
  });

  it("a TRANSACTIONAL job whose file never references the predicate FAILS", () => {
    const jobs = jobsInSource("fixture.ts", FIXTURE_TX_NO_PREDICATE);
    const problems = checkJobs(
      jobs,
      { "fixture.writesEverywhere": spec({}) },
      readAs(FIXTURE_TX_NO_PREDICATE),
    );
    expect(problems.join("\n")).toMatch(/never references acceptsAutomatedWrites/);
  });

  it("the same job passes once the file references the predicate (an import alone does not count)", () => {
    const jobs = jobsInSource("fixture.ts", FIXTURE_TX_WITH_PREDICATE);
    expect(
      checkJobs(jobs, { "fixture.writesEverywhere": spec({}) }, readAs(FIXTURE_TX_WITH_PREDICATE)),
    ).toEqual([]);
    const importOnly = `import { acceptsAutomatedWrites } from "x";\n${FIXTURE_TX_NO_PREDICATE}`;
    expect(
      checkJobs(
        jobsInSource("f.ts", importOnly),
        { "fixture.writesEverywhere": spec({}) },
        readAs(importOnly),
      ).join("\n"),
    ).toMatch(/never references/);
  });

  it("a mention in a comment or string is not a reference", () => {
    const text = `// acceptsAutomatedWrites\nconst s = "acceptsAutomatedWrites";\n${FIXTURE_TX_NO_PREDICATE}`;
    expect(referencesAny(text, ["acceptsAutomatedWrites"])).toBe(false);
  });

  it("an ACTIVE_ONLY row needs a real status: ACTIVE filter; a dead registry row FAILS", () => {
    const noFilter = jobsInSource("f.ts", FIXTURE_TX_NO_PREDICATE);
    expect(
      checkJobs(
        noFilter,
        { "fixture.writesEverywhere": spec({ filter: "ACTIVE_ONLY" }) },
        readAs(FIXTURE_TX_NO_PREDICATE),
      ).join("\n"),
    ).toMatch(/no `status: "ACTIVE"` filter/);
    const withFilter = `${FIXTURE_TX_NO_PREDICATE}\nconst w = { status: "ACTIVE" };`;
    expect(
      checkJobs(
        noFilter,
        { "fixture.writesEverywhere": spec({ filter: "ACTIVE_ONLY" }) },
        readAs(withFilter),
      ),
    ).toEqual([]);
    expect(
      checkJobs(
        noFilter,
        { "fixture.writesEverywhere": spec({}), "gone.job": spec({}) },
        readAs(FIXTURE_TX_WITH_PREDICATE),
      ).join("\n"),
    ).toMatch(/gone.job: in TENANT_JOBS but no such/);
  });

  it("a Bull @Process handler is named <queue>.<process>", () => {
    expect(jobsInSource("p.ts", FIXTURE_PROCESS).map((j) => j.name)).toEqual(["q.do-it"]);
  });
});
