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
  { glob: "apps/api/scripts/*live*", cls: "black", why: "live-tenant script" },

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
  { glob: `${API}/buyer/buyer-auth*`, cls: "red", why: "buyer authentication" },
  { glob: `${API}/common/{db-locks,cron-lock}*`, cls: "red", why: "advisory locks" },
  {
    glob: `${API}/common/{ambient-tenant,assert-refs-in-tenant,derived-jwt-key}*`,
    cls: "red",
    why: "tenant isolation or JWT key",
  },
  { glob: "apps/api/prisma/**", cls: "red", why: "schema and migrations" },
  { glob: `${API}/prisma/**`, cls: "red", why: "Prisma service (tenant scoping)" },
  { glob: ".github/workflows/**", cls: "red", why: "CI pipeline" },
  { glob: ".husky/**", cls: "red", why: "git hooks (the push gate)" },
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
