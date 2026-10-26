// Path-based risk classes: a change's class is the HIGHEST class of any path it touches.
//
// Why: the bug-swarm HIGH guard trusted a triage label an agent wrote (SKILL.md admits a mislabelled
// HIGH row can reach Build). The files a diff touches are mechanical facts, so the class is read from
// them. Classes, low to high: green (docs/e2e), amber (ordinary source), red (money, ledger, units,
// locks, tenancy, auth, migrations, CI), black (secrets, deploy config, prod-migrate/live scripts).
//
// Rules are checked-in data, ordered for the reader; the class is the max over ALL matches, so order
// never changes a result. A `fallback` rule only counts when no other rule matches (the broad amber
// catch-alls), so it cannot outrank a narrower green rule such as docs/**. `except` carves a path out
// of a rule. A path no rule matches is amber: unknown source is not safe enough for the swarm.
// Test files stay in their directory's class: editing money tests is itself the risk.

export const CLASSES = ["green", "amber", "red", "black"];
export const DEFAULT_CLASS = "amber";

const API = "apps/api/src";

export const RULES = [
  // black: a mistake here leaks a secret or changes how prod deploys or migrates.
  { glob: "**/.env*", except: ["**/.env.example"], cls: "black", why: "env file (secrets)" },
  { glob: "**/railway.toml", cls: "black", why: "Railway deploy config" },
  { glob: "**/Dockerfile*", cls: "black", why: "production image build" },
  { glob: "apps/api/scripts/prod-migrate.mjs", cls: "black", why: "applies migrations to prod" },
  { glob: "apps/api/docker-entrypoint.sh", cls: "black", why: "container entrypoint" },
  // "live" as a word (bogo-live-check, live-fix), not inside "delivery"
  {
    glob: "{apps/api/scripts,scripts}/{live-*,*-live-*,*-live.*}",
    cls: "black",
    why: "live-tenant script",
  },
  {
    // CLAUDE_SESSION_PREAMBLE.md "do not call" list (nuke/reset/clear/cleanup/wipe/purge/merge/import) + prod backup/backfills
    glob: "apps/api/scripts/{DANGER-*,nuke-*,reset-seed*,reset-and-seed*,clear-financial-data*,cleanup-qa-data*,wipe-tenant-*,purge-*,ux-audit-cleanup*,qa-deep-audit-cleanup*,merge-duplicate-*,merge-pending-orders*,import-zoho*,backup-production*,backfill-*}",
    cls: "black",
    why: "destructive or prod-data script",
  },
  { glob: "scripts/visibility-*", cls: "black", why: "repo visibility flip (deploy flow)" },
  { glob: "scripts/launchd/**", cls: "black", why: "host launchd jobs (visibility deadman)" },
  { glob: `${API}/assert-secrets.ts`, cls: "black", why: "boot-time secret assertions" },

  // red: money, ledger, units, locks, tenancy, auth, migrations, CI.
  { glob: "packages/pricing/**", cls: "red", why: "money math (@routeflow/pricing)" },
  {
    glob: `${API}/{invoices,credit-notes,vendor-bills,estimates,recurring-invoices}/**`,
    cls: "red",
    why: "finance documents",
  },
  {
    glob: `${API}/{bookkeeping,billing,payment-requests,stripe-connect,supplier-statements}/**`,
    cls: "red",
    why: "ledger, billing or payments",
  },
  {
    glob: `${API}/{returns,promotions,regulated}/**`,
    cls: "red",
    why: "refund, price or filing math",
  },
  { glob: `${API}/inventory/**`, cls: "red", why: "stock ledger" },
  { glob: `${API}/units/**`, cls: "red", why: "unit conversion (boxes/pieces)" },
  { glob: "packages/returns/**", cls: "red", why: "return state and refund math" },
  {
    glob: `${API}/{auth,authorizations,tenant,tenants,users,platform-admin}/**`,
    cls: "red",
    why: "auth or tenancy",
  },
  {
    glob: `${API}/{orders,sales-agents,system-config}/**`,
    cls: "red",
    why: "order totals/merges/stock, commissions, financial-wipe guard",
  },
  {
    glob: `${API}/buyer/{buyer-auth*,guards/**,buyer-tenant*,buyer-link-scope*}`,
    cls: "red",
    why: "buyer authentication and tenant scoping",
  },
  {
    glob: `${API}/buyer/{buyer-order-idempotency,buyer-qty-split}*`,
    cls: "red",
    why: "buyer order dedupe and unit split",
  },
  {
    glob: `${API}/products/{*pric*,line-units*,product-units*,pack-precondition*}`,
    cls: "red",
    why: "product pricing and unit lines",
  },
  {
    glob: `${API}/customers/{*pric*,credit-limit*,*payment*}`,
    cls: "red",
    why: "customer pricing, credit limit, payments",
  },
  {
    glob: `${API}/routes/{complete-payment-reconcile,driver-payments,run-credit-observation,run-invoice-balance,dto/complete-with-payment}*`,
    cls: "red",
    why: "route payments and invoice balance",
  },
  { glob: `${API}/import/import-payment-status*`, cls: "red", why: "imported payment status" },
  {
    glob: `${API}/{messaging,settings-inventory}/require-tenant-context*`,
    cls: "red",
    why: "tenant context guard",
  },
  {
    glob: `${API}/onboarding/{onboarding-tenant,onboarding-token-secret}*`,
    cls: "red",
    why: "tenant creation and token secret",
  },
  {
    glob: `${API}/selling-restrictions/{restriction-tenant,tenant-*}*`,
    cls: "red",
    why: "tenant selling-restriction state",
  },
  { glob: `${API}/uploads/uploads-access*`, cls: "red", why: "tenant file access guard" },
  { glob: `${API}/config/configuration.ts`, cls: "red", why: "env and secret wiring" },
  { glob: `${API}/app.module.ts`, cls: "red", why: "global guards and module wiring" },
  {
    glob: `${API}/common/{db-locks,cron-lock,product-locks,tx-retry,stock-tx}*`,
    cls: "red",
    why: "locks, retry and stock transactions",
  },
  {
    glob: `${API}/common/{ambient-tenant,assert-refs-in-tenant,derived-jwt-key,tenant-class.util,test-tenant-slug,local-db-bypass-urls}*`,
    cls: "red",
    why: "tenant isolation, JWT key or DB-target guard",
  },
  {
    glob: `${API}/common/{money-invariants.util,tax-rate,invoiced-sales,is-whole-cents.validator,line-pack-factors,pricing-rules-ready,msrp,shipping,document-prefix,check-transitions,decimal-bounds}*`,
    cls: "red",
    why: "money, units and document-number invariants",
  },
  {
    glob: `${API}/common/{idempotency.service,webhook-ledger-claim,encryption.service,signed-token,staff-only-fields,pg-session,sentry-redact,throttlers}*`,
    cls: "red",
    why: "idempotency, webhook ledger, crypto, redaction, session or rate-limit",
  },
  { glob: "apps/api/prisma/**", cls: "red", why: "schema and migrations" },
  { glob: `${API}/prisma/**`, cls: "red", why: "Prisma service (tenant scoping)" },
  { glob: ".github/**", cls: "red", why: "CI, actions and dependabot" },
  { glob: ".husky/**", cls: "red", why: "git hooks (the push gate)" },
  {
    glob: "{package.json,package-lock.json,turbo.json}",
    cls: "red",
    why: "root deps and task graph",
  },
  { glob: "scripts/{ci-*,post-deploy-check.mjs}", cls: "red", why: "CI and post-deploy gates" },
  { glob: "scripts/{push-guard,size-ratchet-gate}*", cls: "red", why: "pre-push guards" },
  { glob: "apps/api/prisma.config.ts", cls: "red", why: "Prisma schema/migrations wiring" },
  { glob: `${API}/main.ts`, cls: "red", why: "API boot (global pipes, guards, CORS)" },
  { glob: "apps/web/middleware.ts", cls: "red", why: "web auth and tenant middleware" },
  {
    glob: `{${API}/common,apps/api/scripts/lib}/{production-guard,protected-slugs}*`,
    cls: "red",
    why: "production and protected-tenant guards",
  },
  {
    glob: "scripts/{heavy-slot*,lib/heavy-slot*,lib/check-git-hooks*,lib/scrubbed-git-env*}",
    cls: "red",
    why: "code the gate or the judge imports or wraps",
  },
  {
    glob: "scripts/{lib/risk-paths.mjs,risk-class*}",
    cls: "red",
    why: "the risk judge itself (a diff must not weaken it)",
  },
  { glob: ".claude/skills/bug-swarm/**", cls: "red", why: "swarm gate and workflow" },
  { glob: ".claude/hooks/**", cls: "red", why: "session hooks" },
  { glob: "scripts/lib/test-tenants.*", cls: "red", why: "test-tenant write guard" },

  // green: no runtime effect.
  { glob: "**/*.md", cls: "green", why: "docs" },
  { glob: "docs/**", cls: "green", why: "docs" },
  { glob: ".claude/code-map/**", cls: "green", why: "code map" },
  { glob: ".claude/lessons/**", cls: "green", why: "lessons register" },
  { glob: "apps/web/e2e/**", cls: "green", why: "Playwright E2E" },

  // amber: ordinary source, only when nothing narrower matched.
  { glob: "apps/**", cls: "amber", why: "app source", fallback: true },
  { glob: "packages/**", cls: "amber", why: "shared package", fallback: true },
  { glob: "docker-compose.yml", cls: "amber", why: "local stack", fallback: true },
  { glob: "scripts/**", cls: "amber", why: "repo script", fallback: true },
];

/** Translate a glob (`**`, `*`, `?`, `{a,b}`) over posix paths into an anchored RegExp. */
export function globToRegExp(glob) {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` = zero or more directories
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      depth++;
      re += "(?:";
    } else if (c === "}" && depth > 0) {
      depth--;
      re += ")";
    } else if (c === "," && depth > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const cache = new Map();
export function matchGlob(glob, p) {
  if (!cache.has(glob)) cache.set(glob, globToRegExp(glob));
  return cache.get(glob).test(p);
}

const normalize = (p) =>
  String(p)
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "");
const rank = (cls) => CLASSES.indexOf(cls);

/** True when class `a` is strictly above class `b`. */
export const exceeds = (a, b) => rank(a) > rank(b);

/** The class of one path: the highest class among matching rules ({ cls, rule, why }). */
export function classifyPath(p, rules = RULES) {
  const path = normalize(p);
  const hits = rules.filter(
    (r) => matchGlob(r.glob, path) && !(r.except ?? []).some((e) => matchGlob(e, path)),
  );
  const strong = hits.filter((r) => !r.fallback);
  const pool = strong.length ? strong : hits;
  if (!pool.length) return { cls: DEFAULT_CLASS, rule: null, why: "no rule matched (default)" };
  const top = pool.reduce((a, b) => (rank(b.cls) > rank(a.cls) ? b : a));
  return { cls: top.cls, rule: top.glob, why: top.why };
}

/** The class of a change set: the highest class of any file; empty = green. */
export function classifyDiff(files, rules = RULES) {
  const out = [...new Set(files.map(normalize))].map((path) => ({
    path,
    ...classifyPath(path, rules),
  }));
  const cls = out.reduce((m, f) => (rank(f.cls) > rank(m) ? f.cls : m), "green");
  return { cls, files: out.map(({ path, cls: c, rule }) => ({ path, cls: c, rule })) };
}
