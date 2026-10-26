#!/usr/bin/env node
// Self-test for scripts/risk-class.mjs + scripts/lib/risk-paths.mjs (the path-based risk classifier).
// Plain node; exit 0 when every check passes, 1 otherwise. The git cases build a throwaway repo in the
// OS temp dir and run the real CLI against it, so rename handling and the --max exit code are the real ones.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDiff, classifyPath, globToRegExp } from "./lib/risk-paths.mjs";
import { scrubbedGitEnv } from "./lib/check-git-hooks.mjs";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "risk-class.mjs");
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
ok("amber: unmatched path defaults to amber", cls("turbo.json") === "amber");
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

// CLI: --files
const run = (args, cwd) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd, env: scrubbedGitEnv() });
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
