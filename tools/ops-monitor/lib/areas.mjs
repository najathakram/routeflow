// Product areas: maps a repo path to an area (api module, web screen, mobile role, package,
// infra dir) and an area to a product domain. Areas are derived from the file tree of
// origin/master, never typed. Pure.

const isGroup = (seg) => /^\(.*\)$/.test(seg);
const isParam = (seg) => /^\[.*\]$/.test(seg);

/** `{ area, layer, name }` for a repo-relative path (forward or back slashes). */
export function fileToArea(path) {
  const p = String(path).replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = p.split("/");
  const mk = (layer, name) => ({ area: `${layer}:${name}`, layer, name });
  if (parts[0] === "apps" && parts[1] === "api") {
    if (parts[2] === "src") return parts.length > 4 ? mk("api", parts[3]) : mk("api", "_core");
    if (parts[2] === "prisma") return mk("api", "prisma");
    if (parts[2] === "scripts") return mk("api", "scripts");
    return mk("api", "_core");
  }
  if (parts[0] === "apps" && parts[1] === "web") {
    if (parts[2] === "app") {
      const dirs = parts.slice(3, -1).filter((s) => !isGroup(s) && !isParam(s));
      return dirs.length ? mk("web", dirs[0]) : mk("web", "_shell");
    }
    if (parts[2] === "components")
      return parts.length > 4 ? mk("web", parts[3]) : mk("web", "_components");
    if (parts[2] === "lib") return mk("web", "_lib");
    if (parts[2] === "e2e") return mk("web", "e2e");
    return mk("web", "_other");
  }
  if (parts[0] === "apps" && parts[1] === "mobile") {
    if (parts[2] === "app") {
      if (parts.length > 4 && isGroup(parts[3])) return mk("mobile", parts[3].slice(1, -1));
      return mk("mobile", "_shell");
    }
    return mk("mobile", "_lib");
  }
  if (parts[0] === "packages" && parts.length > 2) return mk("pkg", parts[1]);
  if (parts.length === 1) return mk("infra", "_root");
  return mk("infra", parts[0]);
}

export const DOMAINS = [
  {
    id: "orders",
    label: "Orders & sales",
    names: [
      "orders",
      "order-templates",
      "estimates",
      "returns",
      "counter",
      "pos",
      "buyer",
      "backorders",
      "standing-orders",
      "checkout",
    ],
  },
  {
    id: "catalog",
    label: "Catalog & stock",
    names: [
      "products",
      "product-labels",
      "inventory",
      "suppliers",
      "purchase-orders",
      "units",
      "categories",
      "promotions",
      "selling-restrictions",
      "regulated",
      "price-history",
      "pricing",
    ],
  },
  {
    id: "finance",
    label: "Finance",
    names: [
      "invoices",
      "credit-notes",
      "vendor-bills",
      "recurring-invoices",
      "bookkeeping",
      "payments",
      "reports",
      "analytics",
      "statements",
      "supplier-statements",
      "tax",
      "customer-advances",
    ],
  },
  {
    id: "billing",
    label: "Billing & plans",
    names: ["billing", "subscription", "addons", "platform-pricing", "plans", "stripe"],
  },
  {
    id: "delivery",
    label: "Routes & delivery",
    names: [
      "routes",
      "route-optimization",
      "drivers",
      "driver",
      "trips",
      "deliveries",
      "vehicles",
      "tracking",
      "dispatch",
      "scanning",
    ],
  },
  {
    id: "customers",
    label: "Customers",
    names: [
      "customers",
      "crm",
      "sales-agents",
      "messages",
      "notifications",
      "email",
      "contacts",
      "leads",
      "customer",
    ],
  },
  {
    id: "platform",
    label: "Platform & admin",
    names: [
      "tenant",
      "tenants",
      "auth",
      "users",
      "platform-admin",
      "admin",
      "settings",
      "config",
      "system-config",
      "audit",
      "uploads",
      "storage",
      "import",
      "gateways",
      "health",
      "prisma",
      "_core",
      "_shell",
      "_lib",
      "_components",
      "_other",
      "operator",
      "types",
      "ui",
      "e2e",
    ],
  },
  { id: "tooling", label: "Tooling & ops", names: [] },
  { id: "other", label: "Other", names: [] },
];
const DOMAIN_IDS = new Set(DOMAINS.map((d) => d.id));
const TOOLING_PKGS = new Set(["config", "eslint-config", "typescript-config"]);

/** Domain id for an area id (`api:invoices` → finance); `domain:<id>` passes through. */
export function areaDomain(area) {
  if (typeof area !== "string") return "other";
  const [layer, name] = area.split(":");
  if (layer === "domain") return DOMAIN_IDS.has(name) ? name : "other";
  if (layer === "infra") return "tooling";
  if (layer === "pkg" && TOOLING_PKGS.has(name)) return "tooling";
  if (name === "scripts") return "tooling";
  for (const d of DOMAINS) if (d.names.includes(name)) return d.id;
  return "other";
}

const TEXT_RULES = [
  ["catalog", /product|\bunits?\b|price|catalog|barcode|\bK1\d|family|variant|stock|inventory/i],
  ["finance", /invoice|\btax|vendor bill|credit note|bookkeeping|payment|\bAR\b|money/i],
  ["billing", /billing|add-on|addon|plan pick|stripe|subscription|trial|checkout/i],
  ["orders", /order|counter|\bPOS\b|return|backorder|estimate|walk-in/i],
  ["delivery", /route|driver|deliver|\bscan/i],
  ["customers", /customer|buyer|email|\bcrm\b/i],
  ["platform", /tenant|\bauth|password|backoffice|super admin|settings|permission|login/i],
  ["tooling", /\bCI\b|deploy|train|\blane|hook|script|docker|migration|\bops\b|e2e|playwright/i],
];

/** Best-guess domain id for free text (an item title), or null. */
export function guessDomainFromText(text) {
  if (typeof text !== "string") return null;
  for (const [id, re] of TEXT_RULES) if (re.test(text)) return id;
  return null;
}

const LAYER_ORDER = ["api", "web", "mobile", "pkg", "infra"];

/** Area tree from a list of repo paths: domains (in DOMAINS order) → areas with file counts. */
export function buildAreaTree(paths) {
  const counts = new Map();
  for (const p of paths) {
    const a = fileToArea(p);
    const cur = counts.get(a.area) ?? { ...a, files: 0 };
    cur.files += 1;
    counts.set(a.area, cur);
  }
  const byDomain = new Map(DOMAINS.map((d) => [d.id, []]));
  for (const a of counts.values()) byDomain.get(areaDomain(a.area)).push(a);
  return {
    domains: DOMAINS.map((d) => ({
      id: d.id,
      label: d.label,
      areas: byDomain
        .get(d.id)
        .sort(
          (x, y) =>
            LAYER_ORDER.indexOf(x.layer) - LAYER_ORDER.indexOf(y.layer) ||
            x.name.localeCompare(y.name),
        ),
    })),
  };
}
