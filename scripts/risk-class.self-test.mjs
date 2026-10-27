#!/usr/bin/env node
// Self-test for scripts/risk-class.mjs + scripts/lib/risk-paths.mjs (the path-based risk classifier).
// Plain node; exit 0 when every check passes, 1 otherwise. The git cases build a throwaway repo in the
// OS temp dir and run the real CLI against it, so rename handling and the --max exit code are the real ones.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDiff, classifyPath, globToRegExp } from "./lib/risk-paths.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";
import { diffSince, loadBaseLib } from "./risk-class.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "risk-class.mjs");
const RULES_FILE = path.resolve(HERE, "lib/risk-paths.mjs");
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${cond ? "" : ` ${detail}`}`);
  if (!cond) failed += 1;
};
const cls = (p) => classifyPath(p).cls;

// glob matcher
const g = (glob, p) => globToRegExp(glob).test(p);
ok(
  "glob: ** crosses dirs, * does not",
  g("a/**/c.ts", "a/b/x/c.ts") && !g("a/*/c.ts", "a/b/x/c.ts"),
);
ok(
  "glob: **/ matches zero dirs",
  g("**/Dockerfile*", "Dockerfile") && g("**/.env*", "a/.env.local"),
);
ok(
  "glob: ? is one char, {a,b} alternates",
  g("a?c", "abc") && !g("a?c", "a/c") && g("x/{a,b}/y", "x/b/y"),
);
ok("glob: dots are literal", !g("a.ts", "abts"));

// one path per class
ok("black: env file", cls("apps/api/.env.production") === "black");
ok(
  "black: railway.toml, Dockerfile, prod-migrate",
  ["apps/api/railway.toml", "apps/web/Dockerfile.dev", "apps/api/scripts/prod-migrate.mjs"].every(
    (p) => cls(p) === "black",
  ),
);
ok("black: apps/api/scripts/*live*", cls("apps/api/scripts/run-live-fix.mjs") === "black");
ok("black: .env.example is NOT black", cls("apps/api/.env.example") !== "black");
ok(
  "red: pricing, prisma, workflows, husky",
  [
    "packages/pricing/src/a.ts",
    "apps/api/prisma/migrations/1/migration.sql",
    ".github/workflows/ci.yml",
    ".husky/pre-push",
    "scripts/lib/test-tenants.cjs",
  ].every((p) => cls(p) === "red"),
);
ok(
  "red: api money/auth/tenancy modules",
  [
    "invoices",
    "credit-notes",
    "bookkeeping",
    "billing",
    "auth",
    "tenant",
    "users",
    "units",
    "payment-requests",
  ].every((m) => cls(`apps/api/src/${m}/x.service.ts`) === "red"),
);
ok(
  "red: locks and prisma service",
  cls("apps/api/src/common/db-locks.ts") === "red" &&
    cls("apps/api/src/prisma/prisma.service.ts") === "red",
);
ok(
  "red: test file under a red dir stays red",
  cls("apps/api/src/invoices/invoices.service.spec.ts") === "red" &&
    cls("packages/pricing/src/pricing.spec.ts") === "red",
);
ok("red: a .md inside a red dir stays red", cls("apps/api/prisma/README.md") === "red");
ok(
  "amber: ordinary source",
  [
    "apps/web/app/page.tsx",
    "apps/api/src/products/products.service.ts",
    "packages/ui/x.tsx",
    "docker-compose.yml",
    "scripts/janitor.mjs",
  ].every((p) => cls(p) === "amber"),
);
ok("amber: unmatched path defaults to amber", cls(".prettierignore") === "amber");
ok(
  "green: docs, md, code-map, lessons, e2e",
  [
    "README.md",
    "docs/adr/0001.md",
    ".claude/code-map/api.md",
    ".claude/lessons/LESSONS.md",
    "apps/web/e2e/orders.spec.ts",
  ].every((p) => cls(p) === "green"),
);
ok("green: apps/web/README.md beats the apps/** fallback", cls("apps/web/README.md") === "green");
ok("normalises backslashes and ./", cls(".\\apps\\api\\src\\invoices\\a.ts") === "red");

// review round 1: orders, common money/lock/crypto files, pricing, buyer guards, config, the judge itself
const allAre = (c, ps) => ps.every((p) => cls(p) === c);
const A = "apps/api/src";
ok(
  "red: whole orders module incl. specs",
  allAre("red", [`${A}/orders/orders.service.ts`, `${A}/orders/merge/x.spec.ts`]),
);
ok(
  "red: common money/lock/crypto files and their specs",
  allAre(
    "red",
    [
      "money-invariants.util",
      "tax-rate",
      "invoiced-sales",
      "stock-tx",
      "product-locks",
      "tx-retry",
      "idempotency.service",
      "webhook-ledger-claim",
      "encryption.service",
      "signed-token",
      "is-whole-cents.validator",
      "line-pack-factors",
      "staff-only-fields",
    ].flatMap((n) => [`${A}/common/${n}.ts`, `${A}/common/${n}.spec.ts`]),
  ),
);
ok(
  "red: product/customer pricing, credit limit, buyer guards and tenant, config, app.module",
  allAre("red", [
    `${A}/products/product-price-write.service.ts`,
    `${A}/products/product-pricing.controller.ts`,
    `${A}/customers/customer-price-layer.ts`,
    `${A}/customers/credit-limit-audit.ts`,
    `${A}/buyer/guards/buyer-jwt-auth.guard.ts`,
    `${A}/buyer/buyer-tenant.interceptor.ts`,
    `${A}/config/configuration.ts`,
    `${A}/app.module.ts`,
  ]),
);
ok(
  "amber: a plain products/customers file stays amber",
  allAre("amber", [`${A}/products/product-display-name.ts`, `${A}/customers/csv-x.ts`]),
);
ok("black: assert-secrets.ts", cls(`${A}/assert-secrets.ts`) === "black");
ok(
  "black: scripts/*live*, visibility watchdog and deadman",
  allAre("black", [
    "scripts/bogo-live-check.mjs",
    "scripts/visibility-watchdog.mjs",
    "scripts/visibility-deadman.mjs",
  ]),
);
ok(
  "red: ci scripts, post-deploy-check, all of .github, root package/lock/turbo",
  allAre("red", [
    "scripts/ci-audit-critical.mjs",
    "scripts/post-deploy-check.mjs",
    ".github/dependabot.yml",
    ".github/actions/x/action.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "package.json",
    "package-lock.json",
    "turbo.json",
  ]),
);
// review round 3: scripts/lib, settings, package.json files, next.config, case-insensitive matching
ok(
  "red: apps/api/scripts/lib/** (guards and backfill write logic)",
  allAre("red", [
    "apps/api/scripts/lib/live-target-guard.cjs",
    "apps/api/scripts/lib/local-db-target.cjs",
    "apps/api/scripts/lib/legacy-tenant-backfill.mjs",
  ]),
);
ok(
  "red: .claude/settings*.json",
  allAre("red", [".claude/settings.json", ".claude/settings.local.json"]),
);
ok(
  "red: root and per-app package.json, next.config.*",
  allAre("red", [
    "package.json",
    "apps/api/package.json",
    "apps/web/package.json",
    "apps/mobile/package.json",
    "apps/web/next.config.mjs",
    "apps/web/next.config.js",
  ]),
);
ok("amber: packages/ui/package.json is not covered", cls("packages/ui/package.json") === "amber");
ok(
  "matching is case-insensitive (Windows paths)",
  allAre("red", ["Apps/Api/Src/Invoices/a.ts", "PACKAGES/pricing/a.ts"]) &&
    cls("Apps/Api/.ENV") === "black" &&
    cls("apps/api/.ENV.EXAMPLE") !== "black",
);
ok(
  "red: the judge itself (rules, CLI, self-test, swarm skill, hooks)",
  allAre("red", [
    "scripts/lib/risk-paths.mjs",
    "scripts/risk-class.mjs",
    "scripts/risk-class.self-test.mjs",
    ".claude/skills/bug-swarm/scripts/gate.mjs",
    ".claude/skills/bug-swarm/SKILL.md",
    ".claude/hooks/stop.mjs",
  ]),
);

// diff = max over files
const d = classifyDiff([
  "docs/a.md",
  "apps/web/a.ts",
  "apps/api/src/billing/a.ts",
  "apps/api/.env",
]);
ok("diff: max class wins", d.cls === "black");
ok(
  "diff: per-file class and rule reported",
  d.files.find((f) => f.path === "apps/api/src/billing/a.ts")?.cls === "red" &&
    d.files[0].rule !== undefined,
);
ok(
  "diff: red beats amber and green",
  classifyDiff(["docs/a.md", "apps/web/a.ts", "packages/pricing/a.ts"]).cls === "red",
);
ok("diff: empty is green", classifyDiff([]).cls === "green");

// review round 2: destructive/prod scripts, entrypoint, boot files, everything the judge imports
ok(
  "black: every script CLAUDE_SESSION_PREAMBLE.md forbids, plus backup/backfill/purge",
  allAre(
    "black",
    [
      "DANGER-fresh-data-WIPES-ALL-DATA.js",
      "nuke-db.js",
      "nuke-tenant-data.js",
      "reset-seed.js",
      "reset-and-seed.ts",
      "clear-financial-data.js",
      "cleanup-qa-data.js",
      "wipe-tenant-fresh-start.js",
      "purge-xss-customer-names.js",
      "purge-live-svg-xss.js",
      "ux-audit-cleanup.js",
      "qa-deep-audit-cleanup.js",
      "merge-duplicate-products.js",
      "merge-pending-orders.js",
      "import-zoho.js",
      "backup-production.mjs",
      "backfill-refund-tender.mjs",
      "purge-test-stripe-ids.mjs",
    ].map((n) => `apps/api/scripts/${n}`),
  ),
);
ok(
  "black: docker-entrypoint.sh, scripts/launchd/**, any visibility script",
  allAre("black", [
    "apps/api/docker-entrypoint.sh",
    "scripts/launchd/visibility-deadman-run.sh",
    "scripts/visibility-deadman.mjs",
  ]),
);
ok(
  "red: prisma.config.ts, main.ts, web middleware, guards, push/size gates",
  allAre("red", [
    "apps/api/prisma.config.ts",
    `${A}/main.ts`,
    "apps/web/middleware.ts",
    `${A}/common/production-guard.spec.ts`,
    `${A}/common/protected-slugs.ts`,
    "apps/api/scripts/lib/production-guard.js",
    "apps/api/scripts/lib/protected-slugs.cjs",
    "scripts/push-guard.mjs",
    "scripts/size-ratchet-gate.mjs",
  ]),
);
ok(
  "red: every file the judge imports (git env helpers, heavy-slot wrapper)",
  allAre("red", [
    "scripts/lib/check-git-hooks.mjs",
    "scripts/lib/scrubbed-git-env.cjs",
    "scripts/lib/scrubbed-git-env.d.cts",
    "scripts/heavy-slot.mjs",
    "scripts/lib/heavy-slot.mjs",
  ]),
);
ok(
  "amber: an ordinary apps/api script is still amber",
  cls("apps/api/scripts/report-b673-next-delivery-overcharge.mjs") === "amber",
);

// diffSince asks for type changes too; loadBaseLib falls back ONLY when the base lacks the file
{
  const calls = [];
  const fake = (args) => {
    calls.push(args);
    return args[0] === "merge-base" ? "abc\n" : "T\0scripts/lib/risk-paths.mjs\0";
  };
  const d = diffSince(fake, "master");
  const filter = calls.find((c) => c[0] === "diff")?.find((a) => a.startsWith("--diff-filter="));
  ok(
    "diffSince: --diff-filter includes T and a type change is listed",
    /^--diff-filter=.*T/.test(filter ?? "") && d.files[0] === "scripts/lib/risk-paths.mjs",
    String(filter),
  );
  ok(
    "loadBaseLib: null only when ls-tree says the path is absent at base",
    (await loadBaseLib(() => "", "abc")) === null,
  );
  const timedOut = () => {
    throw Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });
  };
  ok(
    "loadBaseLib: a git failure is NOT a fallback (it rejects)",
    await loadBaseLib(timedOut, "abc").then(
      () => false,
      () => true,
    ),
  );
  const garbage = (args) => (args[0] === "ls-tree" ? "scripts/lib/risk-paths.mjs\n" : "export {;");
  ok(
    "loadBaseLib: a base file that will not import is NOT a fallback (it rejects)",
    await loadBaseLib(garbage, "abc").then(
      () => false,
      () => true,
    ),
  );
}

// CLI: --files
const run = (args, cwd, cli = CLI) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd, env: scrubbedGitEnv() });
let r = run(["--files", "docs/a.md", "apps/web/a.ts", "--json"]);
ok(
  "cli: --files --json",
  r.status === 0 && JSON.parse(r.stdout).cls === "amber",
  r.stdout + r.stderr,
);
r = run(["--files", "apps/api/src/invoices/a.ts", "--max", "green"]);
ok(
  "cli: red path with --max green exits 1 and names path + rule",
  r.status === 1 && /invoices\/a\.ts/.test(r.stderr) && /invoices/.test(r.stderr),
  r.stderr,
);
r = run(["--files", "apps/api/src/invoices/a.ts", "--max", "red"]);
ok("cli: red path with --max red exits 0", r.status === 0, r.stderr);
r = run(["--files", "apps/api/.env", "--max", "red"]);
ok("cli: black path with --max red exits 1", r.status === 1);
r = run(["--bogus"]);
ok("cli: unknown flag exits 2 with usage", r.status === 2 && /usage:/.test(r.stderr), r.stderr);
r = run(["--max", "purple", "--files", "a"]);
ok("cli: bad --max class exits 2", r.status === 2);
r = run(["--files"]);
ok("cli: --files with no paths exits 2", r.status === 2);

// CLI: real git repo
const dir = mkdtempSync(path.join(tmpdir(), "risk-class-"));
const git = (...a) => {
  const x = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...a],
    { cwd: dir, encoding: "utf8", env: scrubbedGitEnv() },
  );
  if (x.status !== 0) throw new Error(`git ${a.join(" ")}: ${x.stderr}`);
  return x.stdout;
};
const put = (p, body = "x\n") => {
  mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  writeFileSync(path.join(dir, p), body);
};
try {
  git("init", "-q", "-b", "master");
  put(
    "apps/api/src/invoices/inv.service.ts",
    "export const a = 1; // line one\n// line two\n// line three\n// line four\n",
  );
  put("README.md");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feat/x");

  put("docs/note.md");
  git("add", "-A");
  git("commit", "-q", "-m", "docs only");
  r = run(["--base", "master", "--max", "green"], dir);
  ok(
    "git: docs-only branch is green, --max green passes",
    r.status === 0 && /risk class: green/.test(r.stdout),
    r.stdout + r.stderr,
  );

  // rename a red file out to an amber path: the OLD (red) path must still count
  mkdirSync(path.join(dir, "apps/web"), { recursive: true });
  renameSync(
    path.join(dir, "apps/api/src/invoices/inv.service.ts"),
    path.join(dir, "apps/web/inv.ts"),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "move out of invoices");
  r = run(["--base", "master", "--json"], dir);
  const j = JSON.parse(r.stdout);
  ok(
    "git: rename counts BOTH paths (old red, new amber)",
    j.cls === "red" &&
      j.files.some((f) => f.path === "apps/api/src/invoices/inv.service.ts" && f.cls === "red") &&
      j.files.some((f) => f.path === "apps/web/inv.ts" && f.cls === "amber"),
    r.stdout,
  );

  // planted red-path diff on a fresh branch from master: --max green must exit 1
  git("checkout", "-q", "master");
  git("checkout", "-q", "-b", "feat/planted");
  put("packages/pricing/src/round.ts");
  put("docs/other.md");
  git("add", "-A");
  git("commit", "-q", "-m", "planted red");
  r = run(["--base", "master", "--max", "green"], dir);
  ok(
    "git: planted red-path diff with --max green exits 1",
    r.status === 1 && /packages\/pricing\/src\/round\.ts/.test(r.stderr),
    r.stdout + r.stderr,
  );
  r = run(["--base", "master", "--max", "red"], dir);
  ok("git: same diff passes --max red", r.status === 0, r.stderr);
  r = run(["--base", "no-such-ref"], dir);
  ok("git: unknown base ref exits 2", r.status === 2, r.stderr);

  // a diff must not weaken its own judge: rules come from the BASE ref, not the branch
  git("checkout", "-q", "master");
  mkdirSync(path.join(dir, "scripts/lib"), { recursive: true });
  copyFileSync(RULES_FILE, path.join(dir, "scripts/lib/risk-paths.mjs"));
  git("add", "-A");
  git("commit", "-q", "-m", "rules on master");
  git("checkout", "-q", "-b", "feat/weaken");
  writeFileSync(
    path.join(dir, "scripts/lib/risk-paths.mjs"),
    'export const CLASSES = ["green"];\nexport const exceeds = () => false;\nexport const classifyDiff = (f) => ({ cls: "green", files: f.map((path) => ({ path, cls: "green", rule: null })) });\n',
  );
  put("packages/pricing/src/round.ts");
  git("add", "-A");
  git("commit", "-q", "-m", "weaken the judge and touch money");
  r = run(["--base", "master", "--max", "amber", "--json"], dir);
  const w = JSON.parse(r.stdout);
  ok(
    "git: a branch that guts risk-paths.mjs is still judged by the base rules (red, exit 1)",
    r.status === 1 &&
      w.cls === "red" &&
      /^base /.test(w.rules) &&
      w.files.some((f) => f.path === "scripts/lib/risk-paths.mjs" && f.cls === "red"),
    r.stdout + r.stderr,
  );

  // the judge must not run branch code: a branch that makes its own risk-paths.mjs exit(0) is still
  // judged red when the classifier is run from a trusted copy (the gate's own checkout) with --repo
  git("checkout", "-q", "master");
  git("checkout", "-q", "-b", "feat/sabotage");
  mkdirSync(path.join(dir, "scripts/lib"), { recursive: true });
  for (const f of ["risk-class.mjs", "lib/check-git-hooks.mjs", "lib/scrubbed-git-env.cjs"])
    copyFileSync(path.join(HERE, f), path.join(dir, "scripts", f));
  writeFileSync(
    path.join(dir, "scripts/lib/risk-paths.mjs"),
    `process.exit(0);\n${readFileSync(RULES_FILE, "utf8")}`,
  );
  put("packages/pricing/src/x.ts");
  git("add", "-A");
  git("commit", "-q", "-m", "sabotage the judge and touch money");
  r = run(["--base", "master", "--max", "amber"], dir, path.join(dir, "scripts/risk-class.mjs"));
  ok("control: the BRANCH copy of the judge is fooled (exit 0)", r.status === 0, r.stderr);
  r = run(["--repo", dir, "--base", "master", "--max", "amber", "--json"], tmpdir());
  const sab = JSON.parse(r.stdout || "{}");
  ok(
    "trusted copy + --repo: sabotaged branch is still red, exit 1, judge files red",
    r.status === 1 &&
      sab.cls === "red" &&
      /^base /.test(sab.rules) &&
      [
        "scripts/lib/risk-paths.mjs",
        "scripts/lib/check-git-hooks.mjs",
        "scripts/risk-class.mjs",
      ].every((p) => sab.files.some((f) => f.path === p && f.cls === "red")),
    r.stdout + r.stderr,
  );
  r = run(["--repo", path.join(dir, "no-such-dir"), "--base", "master"], tmpdir());
  ok("cli: a --repo that is not a repo exits 2", r.status === 2, r.stderr);
  r = run(["--repo"], tmpdir());
  ok("cli: --repo needs a value", r.status === 2);

  // rules tightened on base AFTER the fork: the base TIP rules apply too (max of tip and merge-base)
  git("checkout", "-q", "master");
  git("checkout", "-q", "-b", "feat/old-fork");
  git("checkout", "-q", "master");
  const tight = readFileSync(RULES_FILE, "utf8").replace(
    "export const RULES = [",
    'export const RULES = [\n  { glob: "tools/newly-sensitive/**", cls: "black", why: "tightened after the fork" },',
  );
  writeFileSync(path.join(dir, "scripts/lib/risk-paths.mjs"), tight);
  git("add", "-A");
  git("commit", "-q", "-m", "tighten rules on master");
  git("checkout", "-q", "feat/old-fork");
  put("tools/newly-sensitive/x.mjs");
  git("add", "-A");
  git("commit", "-q", "-m", "touch a path master tightened after the fork");
  r = run(["--repo", dir, "--base", "master", "--max", "amber", "--json"], tmpdir());
  const tj = JSON.parse(r.stdout || "{}");
  ok(
    "git: rules tightened on the base tip after the fork still apply (black, exit 1)",
    r.status === 1 &&
      tj.cls === "black" &&
      tj.files.some((f) => f.path === "tools/newly-sensitive/x.mjs" && f.cls === "black"),
    r.stdout + r.stderr,
  );
  r = run(["--repo", dir, "--base", "master~1", "--json"], tmpdir());
  ok(
    "git: control, the pre-tightening base ref rates that path amber",
    r.status === 0 && JSON.parse(r.stdout).cls === "amber",
    r.stdout + r.stderr,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
