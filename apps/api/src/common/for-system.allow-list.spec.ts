/**
 * SA-1105 Q3 + A-1, K-4: `prisma.forSystem(reason, fn)` is the ONE deliberate unscoped door (callback shape only; the
 * scanner matches the two-argument form, and a bracket access `["forSystem"](` is not seen). Every call site is listed here with
 * its literal reason, and the list must equal what the source holds (set-equal, both ways). A new call fails until it is
 * added HERE, which is where a reviewer reads it. Money paths stay out in slice 1 (SA-619a: billing-cron, billing.service,
 * onboarding-lifecycle, tenant-mirror and the feature-override jobs convert in PR-2, under the owner's review).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const SRC = path.join(__dirname, "..");
const walk = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")
          ? [path.join(dir, e.name)]
          : [],
    );

/** One row per call site: the file (relative to src) and the literal reason. */
export const ALLOWED: ReadonlyArray<{ file: string; reason: string }> = [
  { file: "inventory/low-stock-digest.service.ts", reason: "low-stock digest: cross-tenant scan" },
  {
    file: "billing/billing-cron.service.ts",
    reason: "billing cron: expire ended trials across businesses",
  },
  {
    file: "billing/billing-cron.service.ts",
    reason: "billing cron: warn businesses whose trial is ending",
  },
  {
    file: "billing/billing-cron.service.ts",
    reason: "billing cron: expire payment grace across businesses",
  },
  {
    file: "billing/billing-cron.service.ts",
    reason: "billing cron: apply scheduled plan downgrades",
  },
  {
    file: "billing/billing-cron.service.ts",
    reason: "billing cron: push upcoming downgrade prices",
  },
  {
    file: "billing/billing-cron.service.ts",
    reason: "billing cron: apply scheduled cancellations",
  },
  {
    file: "billing/billing-cron.service.ts",
    reason: "billing cron: roll billing cycles across businesses",
  },
  {
    file: "billing/billing.service.ts",
    reason: "billing: reconcile parked checkouts across businesses",
  },
  {
    file: "billing/billing.service.ts",
    reason: "billing: reconcile canceled subscriptions across businesses",
  },
  {
    file: "billing/feature-override-review.job.ts",
    reason: "feature grants: review expired overrides across businesses",
  },
  {
    file: "billing/feature-override-review.job.ts",
    reason: "feature grants: warn billable pilots ending",
  },
  {
    file: "billing/feature-override-expiry.job.ts",
    reason: "feature grants: revoke expired overrides across businesses",
  },
  {
    file: "platform-admin/tenant-mirror.service.ts",
    reason: "platform mirror: sync businesses to the house business",
  },
  {
    file: "onboarding/onboarding-lifecycle.service.ts",
    reason: "onboarding: send reminders across businesses",
  },
  {
    file: "onboarding/onboarding-lifecycle.service.ts",
    reason: "onboarding: purge expired intake files across businesses",
  },
];

export interface Found {
  file: string;
  reason: string | null; // null = not a string literal
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Every `.forSystem(` call, read as `forSystem("<literal>", fn)` (the declaration has no leading dot). */
export function scanForSystem(files: Array<{ file: string; text: string }>): Found[] {
  const out: Found[] = [];
  for (const { file, text } of files) {
    for (const m of strip(text).matchAll(/\.forSystem\(\s*(?:(["'`])([^"'`]*)\1\s*,)?/g)) {
      out.push({ file, reason: m[1] && !m[2].includes("${") ? m[2] : null });
    }
  }
  return out;
}

const key = (f: Found) => `${f.file} :: ${f.reason}`;

describe("K-4 forSystem allow-list", () => {
  it("the call sites in the source are set-equal to the allow-list, each with a literal reason of 12+ characters", () => {
    const files = walk(SRC).map((f) => ({
      file: path.relative(SRC, f).split(path.sep).join("/"),
      text: fs.readFileSync(f, "utf8"),
    }));
    const found = scanForSystem(files);
    expect(found.map(key).sort()).toEqual(ALLOWED.map(key).sort());
    for (const f of found) expect((f.reason ?? "").length).toBeGreaterThanOrEqual(12);
  });

  it("self-test: an unlisted call is reported", () => {
    const found = scanForSystem([
      {
        file: "x/new-job.ts",
        text: 'await this.prisma.forSystem("a brand new unlisted sweep", async (db) => db.order.findMany());',
      },
    ]);
    expect(found).toEqual([{ file: "x/new-job.ts", reason: "a brand new unlisted sweep" }]);
    const unlisted = found.map(key).filter((k) => !ALLOWED.map(key).includes(k));
    expect(unlisted).toHaveLength(1);
  });

  it("self-test: a non-literal reason is reported as null, and a template with interpolation too", () => {
    const found = scanForSystem([
      { file: "x/a.ts", text: "this.prisma.forSystem(reason, async (db) => db.user.findMany());" },
      {
        file: "x/b.ts",
        text: "this.prisma.forSystem(`sweep ${name}`, async (db) => db.user.findMany());",
      },
      { file: "x/c.ts", text: 'this.prisma.forSystem("a client-returning one-argument form");' },
    ]);
    expect(found.map((f) => f.reason)).toEqual([null, null, null]);
  });

  it("self-test: the declaration and a comment are not call sites", () => {
    const found = scanForSystem([
      {
        file: "prisma/prisma.service.ts",
        text: '  forSystem<T>(reason: string, fn: (db: this) => Promise<T>) {\n  // x.forSystem("nope nope nope", fn)\n  }',
      },
    ]);
    expect(found).toEqual([]);
  });
});

/**
 * B1284 (SA-1105 A-2): `forSystem` is the ONLY door to the tenant-context kind SYSTEM. Construction: `run()` cannot name
 * SYSTEM (B4-1, a type error in prisma-tenant-context-kind.spec). Pin, for what a type cannot see (a cast, an element
 * access): every use of the name `runSystem` in non-spec source is `PrismaService.forSystem`, and no `.run(` call passes
 * the string literal "SYSTEM".
 */
export interface SystemDoorScan {
  /** `file::Class.method` of every use of the name `runSystem` that is not its definition. */
  runSystemUses: string[];
  /** `file` of every `.run(` call that passes the string literal "SYSTEM". */
  runWithSystem: string[];
}

/** `Class.method` (or `<top>`) enclosing a node. */
function enclosing(n: ts.Node): string {
  let cls = "";
  let fn = "";
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (!fn && (ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p)) && p.name) {
      fn = p.name.getText();
    }
    if (ts.isClassDeclaration(p) && p.name) {
      cls = p.name.text;
      break;
    }
  }
  return cls || fn ? `${cls}.${fn}` : "<top>";
}

export function scanSystemDoor(files: Array<{ file: string; text: string }>): SystemDoorScan {
  const out: SystemDoorScan = { runSystemUses: [], runWithSystem: [] };
  for (const { file, text } of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      const isName =
        (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
        n.text === "runSystem";
      const isDefinition = isName && ts.isMethodDeclaration(n.parent) && n.parent.name === n;
      if (isName && !isDefinition) out.runSystemUses.push(`${file}::${enclosing(n)}`);
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "run" &&
        n.arguments.some((a) => ts.isStringLiteralLike(a) && a.text === "SYSTEM")
      ) {
        out.runWithSystem.push(file);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  out.runSystemUses.sort();
  out.runWithSystem.sort();
  return out;
}

const DOOR = ["prisma/prisma.service.ts::PrismaService.forSystem"];

describe("B4-2 the SYSTEM kind has one door", () => {
  it("runSystem is used only by PrismaService.forSystem, and no .run( call names SYSTEM", () => {
    const files = walk(SRC).map((f) => ({
      file: path.relative(SRC, f).split(path.sep).join("/"),
      text: fs.readFileSync(f, "utf8"),
    }));
    const found = scanSystemDoor(files);
    expect(found.runSystemUses).toEqual(DOOR);
    expect(found.runWithSystem).toEqual([]);
  });

  it("self-test: a second producer, in any spelling, is reported", () => {
    const found = scanSystemDoor([
      {
        file: "x/second-door.ts",
        text: [
          "class Job {",
          "  a() { return this.ctx.runSystem('sneaky reason here', () => 1); }",
          "  b() { return (this.ctx as any)['runSystem']('sneaky reason here', () => 1); }",
          "  c() { return this.ctx.run(null, () => 1, 'SYSTEM'); }",
          "}",
        ].join("\n"),
      },
      {
        file: "tenant/tenant-context.service.ts",
        text: "class TenantContextService { runSystem<T>(reason: string, fn: () => T): T { return fn(); } }",
      },
    ]);
    expect(found.runSystemUses).toEqual(["x/second-door.ts::Job.a", "x/second-door.ts::Job.b"]);
    expect(found.runWithSystem).toEqual(["x/second-door.ts"]);
  });
});

/**
 * SA-1105 A-2, PR-2b: the SA-619a cross-tenant cron jobs run inside the deliberate door. Each entry names the job method and
 * the literal reason of its `forSystem(reason, ...)` call, which must also be an allow-list row. The method body is the
 * old body word for word, wrapped; this pin fails when a job is moved back onto the bare client or its reason drifts.
 */
export const CONVERTED_JOBS: ReadonlyArray<{
  file: string;
  cls: string;
  method: string;
  reason: string;
}> = [
  {
    file: "billing/billing-cron.service.ts",
    cls: "BillingCronService",
    method: "expireTrials",
    reason: "billing cron: expire ended trials across businesses",
  },
  {
    file: "billing/billing-cron.service.ts",
    cls: "BillingCronService",
    method: "warnTrialsEnding",
    reason: "billing cron: warn businesses whose trial is ending",
  },
  {
    file: "billing/billing-cron.service.ts",
    cls: "BillingCronService",
    method: "expireGrace",
    reason: "billing cron: expire payment grace across businesses",
  },
  {
    file: "billing/billing-cron.service.ts",
    cls: "BillingCronService",
    method: "applyScheduledDowngrades",
    reason: "billing cron: apply scheduled plan downgrades",
  },
  {
    file: "billing/billing-cron.service.ts",
    cls: "BillingCronService",
    method: "pushUpcomingDowngradePrices",
    reason: "billing cron: push upcoming downgrade prices",
  },
  {
    file: "billing/billing-cron.service.ts",
    cls: "BillingCronService",
    method: "applyScheduledCancellations",
    reason: "billing cron: apply scheduled cancellations",
  },
  {
    file: "billing/billing-cron.service.ts",
    cls: "BillingCronService",
    method: "rollCycles",
    reason: "billing cron: roll billing cycles across businesses",
  },
  {
    file: "billing/billing.service.ts",
    cls: "BillingService",
    method: "reconcileParkedCheckouts",
    reason: "billing: reconcile parked checkouts across businesses",
  },
  {
    file: "billing/billing.service.ts",
    cls: "BillingService",
    method: "reconcileCanceledSubscriptions",
    reason: "billing: reconcile canceled subscriptions across businesses",
  },
  {
    file: "billing/feature-override-review.job.ts",
    cls: "FeatureOverrideReviewJob",
    method: "reviewExpiredOverrides",
    reason: "feature grants: review expired overrides across businesses",
  },
  {
    file: "billing/feature-override-review.job.ts",
    cls: "FeatureOverrideReviewJob",
    method: "warnBillablePilotsEnding",
    reason: "feature grants: warn billable pilots ending",
  },
  {
    file: "billing/feature-override-expiry.job.ts",
    cls: "FeatureOverrideExpiryJob",
    method: "revokeExpiredOverrides",
    reason: "feature grants: revoke expired overrides across businesses",
  },
  {
    file: "platform-admin/tenant-mirror.service.ts",
    cls: "TenantMirrorService",
    method: "mirrorSync",
    reason: "platform mirror: sync businesses to the house business",
  },
  {
    file: "onboarding/onboarding-lifecycle.service.ts",
    cls: "OnboardingLifecycleService",
    method: "sendRemindersCron",
    reason: "onboarding: send reminders across businesses",
  },
  {
    file: "onboarding/onboarding-lifecycle.service.ts",
    cls: "OnboardingLifecycleService",
    method: "purgeIntakeFilesCron",
    reason: "onboarding: purge expired intake files across businesses",
  },
];

/** The literal first argument of every `forSystem(` call made directly inside `cls.method`. */
export function forSystemReasonsInMethod(text: string, cls: string, method: string): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const inMethod = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "forSystem" &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      out.push(n.arguments[0].text);
    }
    ts.forEachChild(n, inMethod);
  };
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name?.text === cls) {
      for (const m of n.members) {
        if (ts.isMethodDeclaration(m) && m.name.getText() === method) inMethod(m);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * L-1: the old body must run INSIDE the callback. Every `this.prisma.<x>` read in the method other than `forSystem`
 * itself that sits outside a `forSystem` callback (a function or arrow, the 2nd argument), plus any `forSystem` call
 * whose 2nd argument is not a function, is returned. An empty wrapper with the query beside it is therefore non-empty.
 */
export function prismaOutsideForSystem(text: string, cls: string, method: string): string[] {
  const sf = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const walkBody = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "forSystem"
    ) {
      const cb = n.arguments[1];
      if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) out.push("no callback");
      n.arguments.forEach((a, i) => i !== 1 && walkBody(a));
      return;
    }
    if (ts.isPropertyAccessExpression(n) && n.expression.getText() === "this.prisma") {
      out.push(n.name.text);
    }
    ts.forEachChild(n, walkBody);
  };
  const visit = (n: ts.Node) => {
    if (ts.isClassDeclaration(n) && n.name?.text === cls) {
      for (const m of n.members) {
        if (ts.isMethodDeclaration(m) && m.name.getText() === method) walkBody(m);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("C-2 the SA-619a cron jobs run inside forSystem", () => {
  it("no converted job touches this.prisma outside its forSystem callback", () => {
    for (const j of CONVERTED_JOBS) {
      const text = fs.readFileSync(path.join(SRC, j.file), "utf8");
      expect({
        job: `${j.cls}.${j.method}`,
        outside: prismaOutsideForSystem(text, j.cls, j.method),
      }).toEqual({ job: `${j.cls}.${j.method}`, outside: [] });
    }
  });

  it("self-test: an empty wrapper with the query beside it, or a non-function callback, is reported", () => {
    const inside =
      'class J { async run() { return this.prisma.forSystem("some reason here", async () => this.prisma.tenant.findMany()); } }';
    expect(prismaOutsideForSystem(inside, "J", "run")).toEqual([]);
    const beside =
      'class J { async run() { const r = await this.prisma.tenant.findMany(); return this.prisma.forSystem("some reason here", async () => r); } }';
    expect(prismaOutsideForSystem(beside, "J", "run")).toEqual(["tenant"]);
    const notFn =
      'class J { async run() { return this.prisma.forSystem("some reason here", this.sweep()); } }';
    expect(prismaOutsideForSystem(notFn, "J", "run")).toEqual(["no callback"]);
  });

  it("each converted job method calls forSystem with its allow-list reason, exactly once", () => {
    for (const j of CONVERTED_JOBS) {
      const text = fs.readFileSync(path.join(SRC, j.file), "utf8");
      expect({
        job: `${j.cls}.${j.method}`,
        reasons: forSystemReasonsInMethod(text, j.cls, j.method),
      }).toEqual({
        job: `${j.cls}.${j.method}`,
        reasons: [j.reason],
      });
      expect(ALLOWED).toContainEqual({ file: j.file, reason: j.reason });
    }
  });

  it("every allow-list row beyond the first conversion belongs to a converted job (no orphan rows)", () => {
    const converted = new Set(CONVERTED_JOBS.map((j) => `${j.file} :: ${j.reason}`));
    const rest = ALLOWED.map(key).filter((k) => !converted.has(k));
    expect(rest).toEqual([
      "inventory/low-stock-digest.service.ts :: low-stock digest: cross-tenant scan",
    ]);
  });

  it("self-test: a job method without a forSystem call, or with another reason, is reported", () => {
    const bare = "class J { async run() { return this.prisma.tenant.findMany(); } }";
    expect(forSystemReasonsInMethod(bare, "J", "run")).toEqual([]);
    const wrapped =
      'class J { async run() { return this.prisma.forSystem("a different reason", async () => 1); } }';
    expect(forSystemReasonsInMethod(wrapped, "J", "run")).toEqual(["a different reason"]);
    const elsewhere =
      'class J { other() { return this.prisma.forSystem("some other job", async () => 1); } async run() {} }';
    expect(forSystemReasonsInMethod(elsewhere, "J", "run")).toEqual([]);
  });
});
