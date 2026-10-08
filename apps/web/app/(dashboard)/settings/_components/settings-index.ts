/**
 * Settings search index - the data behind the hub's search box (and the hub's own group lists).
 * Every hub link, every card that lives on a settings screen and a few "where do I do X" answers
 * are entries here, each with the words people actually type (counter, carrier, backorder ...).
 * Pure data + pure functions: no React, no hooks. The hub keeps group titles/icons; this file
 * keeps what can be found and where it lives.
 */

export type IndexEntry = {
  /** Stable kebab id. */
  id: string;
  /** item = a screen/page, card = a card on a screen, info = an answer (not a link). */
  kind: "item" | "card" | "info";
  label: string;
  desc: string;
  /** Absent for info rows. */
  href?: string;
  /** Info rows only: the sentence shown instead of desc. */
  answer?: string;
  /** business | selling | orders | notifications | compliance | integrations | billing | footer */
  groupKey: string;
  /** Breadcrumb tail, e.g. "Invoicing" (defaults to the label). */
  page?: string;
  keywords: string[];
  show?: "admin";
  needs?: "fleet";
  /** Filled by a later change; a row shows `affects ?? desc`. */
  affects?: string;
};

const R = "/settings/restrictions";

const ENTRIES: IndexEntry[] = [
  // ── Business & team ──────────────────────────────────────────────────────────────────────
  {
    id: "business-profile",
    kind: "item",
    label: "Business profile",
    desc: "Name, address, logo & default tax rate",
    href: "/settings?tab=profile",
    groupKey: "business",
    keywords: ["tax", "sales tax", "logo", "address", "phone", "company"],
  },
  {
    id: "user-management",
    kind: "item",
    label: "User management",
    desc: "Operators & drivers, roles, passwords",
    href: "/settings?tab=users",
    groupKey: "business",
    keywords: [
      "staff",
      "team",
      "invite",
      "add user",
      "driver",
      "operator",
      "role",
      "reset password",
    ],
  },
  // ── Selling & catalog ────────────────────────────────────────────────────────────────────
  {
    id: "invoicing",
    kind: "item",
    label: "Invoicing",
    desc: "Numbering, terms & default notes",
    href: "/settings?tab=invoicing",
    groupKey: "selling",
    keywords: [
      "terms",
      "net 30",
      "due date",
      "days to pay",
      "prefix",
      "invoice number",
      "notes",
      "deposit",
    ],
  },
  {
    id: "costing",
    kind: "item",
    label: "Costing",
    desc: "Costing method & margin floors",
    href: "/settings?tab=costing",
    groupKey: "selling",
    keywords: ["margin", "cogs", "fifo", "cost"],
  },
  {
    id: "how-to-pay",
    kind: "item",
    label: "How to pay",
    desc: "Remit-to & payment instructions",
    href: "/settings?tab=remittance",
    groupKey: "selling",
    keywords: ["bank", "remit", "check", "ach", "wire", "zelle"],
  },
  {
    id: "restrictions-selling",
    kind: "item",
    label: "Selling restrictions",
    desc: "Block restricted products by the customer's state",
    href: R,
    groupKey: "selling",
    keywords: ["restriction", "state", "blocked", "banned", "age", "tobacco", "vape", "compliance"],
  },
  {
    id: "import-data",
    kind: "item",
    label: "Import data",
    desc: "CSV importers, numbering & finish setup",
    href: "/settings/import",
    groupKey: "selling",
    keywords: ["numbering", "next number", "sequence", "csv", "upload"],
  },
  {
    id: "migration",
    kind: "item",
    label: "Migration",
    desc: "Move from Zoho, QuickBooks, CSV or paper",
    href: "/settings/migration",
    groupKey: "selling",
    keywords: ["zoho", "quickbooks", "switch", "move"],
  },
  // ── Orders & stock ───────────────────────────────────────────────────────────────────────
  {
    id: "route-defaults",
    kind: "item",
    label: "Route defaults",
    desc: "Service time, start time, speed & depot location",
    href: "#route-defaults",
    groupKey: "orders",
    needs: "fleet",
    keywords: ["route", "depot", "speed", "service time", "start time", "eta"],
  },
  {
    id: "out-of-stock-ordering",
    kind: "item",
    label: "Out-of-stock ordering",
    desc: "Let customers order items that are out of stock",
    href: "#out-of-stock-ordering",
    groupKey: "orders",
    keywords: [
      "backorder",
      "back order",
      "oversell",
      "out of stock",
      "sold out",
      "negative stock",
      "stock",
    ],
  },
  {
    id: "batch-invoice-import",
    kind: "item",
    label: "Batch invoice import",
    desc: "Scan a stack of bills/photos into invoices",
    href: "/settings/batch-import",
    groupKey: "orders",
    keywords: ["scan", "bills", "photos", "ocr"],
  },
  // ── Notifications ────────────────────────────────────────────────────────────────────────
  {
    id: "notifications",
    kind: "item",
    label: "Notifications",
    desc: "Event rules, message templates, quiet hours & low-stock digest",
    href: "/settings?tab=notifications",
    groupKey: "notifications",
    keywords: ["sms", "whatsapp", "text", "template", "quiet hours", "reminder"],
  },
  {
    id: "email-smtp",
    kind: "item",
    label: "Email (SMTP)",
    desc: "Sender identity & delivery settings",
    href: "/settings?tab=email",
    groupKey: "notifications",
    keywords: [
      "smtp",
      "sender",
      "from address",
      "domain",
      "mailbox",
      "gmail",
      "outlook",
      "deliverability",
    ],
  },
  // ── Compliance ───────────────────────────────────────────────────────────────────────────
  {
    id: "regulated-sections",
    kind: "item",
    label: "Regulated sections",
    desc: "Tracked categories, tax rules & subcategories",
    href: "/settings?tab=regulated",
    groupKey: "compliance",
    show: "admin",
    keywords: ["tobacco", "vape", "compliance", "tax rules", "subcategory"],
  },
  {
    id: "restrictions-compliance",
    kind: "item",
    label: "Selling restrictions",
    desc: "Block restricted products by the customer's state",
    href: R,
    groupKey: "compliance",
    keywords: ["restriction", "state", "blocked", "banned", "age", "tobacco", "vape", "compliance"],
  },
  {
    id: "product-labels",
    kind: "item",
    label: "Product labels",
    desc: "Restriction categories applied to products",
    href: "/settings/product-categories",
    groupKey: "compliance",
    show: "admin",
    keywords: ["restriction", "category", "tag", "compliance"],
  },
  // ── Integrations ─────────────────────────────────────────────────────────────────────────
  {
    id: "claude-scanner",
    kind: "item",
    label: "Claude AI scanner",
    desc: "API key for invoice/bill scanning",
    href: "/settings?tab=integrations",
    groupKey: "integrations",
    keywords: ["ai", "ocr", "scan", "anthropic", "claude", "photo"],
  },
  {
    id: "gohighlevel",
    kind: "item",
    label: "GoHighLevel",
    desc: "Create customers from won leads",
    href: "/settings?tab=gohighlevel",
    groupKey: "integrations",
    keywords: ["crm", "leads", "ghl"],
  },
  // ── Billing ──────────────────────────────────────────────────────────────────────────────
  {
    id: "plan-billing",
    kind: "item",
    label: "Plan & billing",
    desc: "Subscription, usage & add-ons",
    href: "/settings/billing",
    groupKey: "billing",
    keywords: ["plan", "subscription", "add-on", "upgrade", "usage"],
  },
  // ── My account (footer) ──────────────────────────────────────────────────────────────────
  {
    id: "my-account",
    kind: "item",
    label: "My account",
    desc: "Password, active sessions, Google sign-in & driver access",
    href: "/settings?tab=account",
    groupKey: "footer",
    page: "Overview",
    keywords: ["password", "sign in", "sign-in", "google", "sessions", "2-step"],
  },

  // ── Cards that live on a settings screen ─────────────────────────────────────────────────
  {
    id: "card-payments",
    kind: "card",
    label: "Card payments",
    desc: "Take card payments from customers with Stripe",
    href: "/settings#card-payments",
    groupKey: "billing",
    page: "Card payments",
    keywords: ["stripe", "card", "credit card", "online payment", "pay online"],
  },
  {
    id: "tier-names",
    kind: "card",
    label: "Pricing tier names",
    desc: "Rename your price levels",
    href: "/settings#tier-names",
    groupKey: "selling",
    page: "Pricing tier names",
    keywords: ["tier", "price level", "price list", "wholesale price"],
  },
  ...card(
    "business-info",
    "Business info",
    "Name, phone and email on your documents",
    "profile",
    "business",
    "Business profile",
    ["company", "phone"],
  ),
  ...card(
    "business-address",
    "Business address",
    "Where your business is based",
    "profile",
    "business",
    "Business profile",
    ["address", "location"],
  ),
  ...card(
    "logo",
    "Logo",
    "The logo printed on invoices and emails",
    "profile",
    "business",
    "Business profile",
    ["logo", "brand"],
  ),
  ...card(
    "tax",
    "Default tax rate",
    "The tax rate new orders start with",
    "profile",
    "business",
    "Business profile",
    ["tax", "sales tax"],
  ),
  ...card(
    "payment-terms",
    "Payment terms",
    "How many days customers have to pay",
    "invoicing",
    "selling",
    "Invoicing",
    ["terms", "net 30", "due date", "days to pay", "invoice"],
  ),
  ...card(
    "original-price",
    "Show original price",
    "Show the list price next to a discounted price",
    "invoicing",
    "selling",
    "Invoicing",
    ["discount", "list price", "invoice"],
  ),
  ...card(
    "deposits",
    "Deposits",
    "Ask for a deposit before an order ships",
    "invoicing",
    "selling",
    "Invoicing",
    ["deposit", "prepay", "down payment", "invoice"],
  ),
  ...card(
    "invoice-numbering",
    "Invoice numbering",
    "Prefix and the next invoice number",
    "invoicing",
    "selling",
    "Invoicing",
    ["prefix", "invoice number", "next number", "sequence", "invoice"],
  ),
  ...card(
    "invoice-defaults",
    "Invoice defaults",
    "Notes and footer printed on every invoice",
    "invoicing",
    "selling",
    "Invoicing",
    ["notes", "footer", "default notes", "invoice"],
  ),
  ...card(
    "costing-method",
    "Costing method",
    "How product cost is worked out",
    "costing",
    "selling",
    "Costing",
    ["fifo", "average cost", "cogs", "cost"],
  ),
  ...card(
    "margin-floors",
    "Margin floors",
    "The lowest margin you will sell at",
    "costing",
    "selling",
    "Costing",
    ["margin", "minimum price"],
  ),
  ...card(
    "remit-to",
    "Remit-to address",
    "Where customers send payment",
    "remittance",
    "selling",
    "How to pay",
    ["remit", "check", "mail"],
  ),
  ...card(
    "payment-instructions",
    "Payment instructions",
    "Bank, ACH, wire or Zelle details shown on invoices",
    "remittance",
    "selling",
    "How to pay",
    ["bank", "ach", "wire", "zelle"],
  ),
  ...card(
    "notification-rules",
    "Notification rules",
    "Which events send a message, and to whom",
    "notifications",
    "notifications",
    "Notifications",
    ["event", "rule", "sms", "whatsapp"],
  ),
  ...card(
    "quiet-hours",
    "Quiet hours",
    "Hold messages overnight",
    "notifications",
    "notifications",
    "Notifications",
    ["quiet hours", "overnight", "do not disturb"],
  ),
  ...card(
    "low-stock-digest",
    "Low-stock digest",
    "A daily email of products running low",
    "notifications",
    "notifications",
    "Notifications",
    ["low stock", "reorder", "digest", "stock alert", "inventory email"],
  ),
  ...card(
    "push",
    "Push notifications",
    "Alerts on your phone",
    "notifications",
    "notifications",
    "Notifications",
    ["push", "phone", "app alert"],
  ),
  ...card(
    "delivery-health",
    "Delivery health",
    "Whether your messages are getting through",
    "notifications",
    "notifications",
    "Notifications",
    ["bounce", "failed", "deliverability"],
  ),
  ...card(
    "smtp",
    "SMTP server",
    "Send email through your own mail server",
    "email",
    "notifications",
    "Email (SMTP)",
    ["smtp", "server", "host"],
  ),
  ...card(
    "sending-domain",
    "Sending domain",
    "Verify the domain invoices are sent from",
    "email",
    "notifications",
    "Email (SMTP)",
    ["domain", "from address", "dns", "deliverability"],
  ),
  ...card(
    "mailbox",
    "Mailbox",
    "Connect Gmail or Outlook to send as you",
    "email",
    "notifications",
    "Email (SMTP)",
    ["gmail", "outlook", "mailbox", "sender"],
  ),
  ...card("password", "Password", "Change your sign-in password", "account", "footer", undefined, [
    "password",
    "sign in",
  ]),
  ...card(
    "google-sign-in",
    "Google sign-in",
    "Link your Google account to sign in",
    "account",
    "footer",
    undefined,
    ["google", "sign in", "linked"],
  ),
  ...card(
    "sessions",
    "Active sessions",
    "Where you are signed in, and sign out others",
    "account",
    "footer",
    undefined,
    ["sessions", "devices", "sign out"],
  ),
  ...card(
    "driver-access",
    "Driver access",
    "How drivers sign in to the app",
    "account",
    "footer",
    undefined,
    ["driver", "pin", "app"],
  ),

  // ── Answers (not links) ──────────────────────────────────────────────────────────────────
  {
    id: "info-shipping-carrier",
    kind: "info",
    label: "Shipping carrier",
    desc: "Which carrier ships an order",
    answer: "You choose the carrier on each order when you mark it shipped.",
    groupKey: "orders",
    keywords: [
      "ship",
      "shipping",
      "carrier",
      "ups",
      "fedex",
      "usps",
      "dhl",
      "tracking",
      "fulfil",
      "fulfilment",
      "fulfillment",
      "delivery method",
      "pickup",
      "pick up",
    ],
  },
  {
    id: "info-last-price",
    kind: "info",
    label: "Last price a customer paid",
    desc: "Prices filled in on new orders",
    answer: "New orders fill in the last price you gave this customer.",
    groupKey: "orders",
    keywords: ["last price", "previous price", "price history", "customer price"],
  },
  {
    id: "info-reorder-points",
    kind: "info",
    label: "Reorder points",
    desc: "When a product counts as low on stock",
    answer: "Set a reorder point on each product. The low-stock digest uses it.",
    groupKey: "orders",
    keywords: ["low stock", "reorder", "digest", "stock alert", "inventory email"],
  },
  {
    id: "info-batch-ship",
    kind: "info",
    label: "Ship several orders at once",
    desc: "Mark many orders shipped together",
    answer: "Select orders on the Orders list, then choose Mark shipped.",
    groupKey: "orders",
    keywords: ["bulk", "batch", "ship", "mark shipped", "tracking"],
  },
  {
    id: "info-counter-sales",
    kind: "info",
    label: "Counter sales",
    desc: "Sell to walk-in customers",
    answer:
      "Ring up walk-in customers from the Orders screen. Not there? Ask RouteFlow support to turn it on.",
    groupKey: "orders",
    keywords: [
      "counter",
      "walk-in",
      "walk in",
      "till",
      "register",
      "pos",
      "in-store",
      "cash sale",
      "retail",
    ],
  },
];

/** A card that lives on a `?tab=` screen: deep-links to `#id` on that screen. */
function card(
  id: string,
  label: string,
  desc: string,
  tab: string,
  groupKey: string,
  page: string | undefined,
  keywords: string[],
): IndexEntry[] {
  return [
    { id, kind: "card", label, desc, href: `/settings?tab=${tab}#${id}`, groupKey, page, keywords },
  ];
}

/** Carrier-only (fleet-off) accounts have no drivers: user management must not promise them. */
const USERS_DESC_NO_FLEET = "Team members, roles, passwords";

/** The entries a viewer can see: admin-only and fleet-only rows are dropped, never greyed out. */
export function buildIndex(o: { isAdmin: boolean; fleet: boolean }): IndexEntry[] {
  return ENTRIES.filter((e) => (e.show === "admin" ? o.isAdmin : true))
    .filter((e) => (e.needs === "fleet" ? o.fleet : true))
    .map((e) =>
      e.id === "user-management" && !o.fleet
        ? { ...e, desc: USERS_DESC_NO_FLEET, keywords: e.keywords.filter((k) => k !== "driver") }
        : e,
    );
}

/** Lowercase, punctuation -> space, one trailing "s" dropped from words longer than 3. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ");
}

/**
 * Every query word must appear in the entry's label, description, keywords or page (the group
 * title is not searched). Ranked label 3 / keyword 2 / description 1 per word; ties keep index order.
 */
export function searchIndex(q: string, entries: IndexEntry[]): IndexEntry[] {
  const tokens = normalize(q).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const scored: { e: IndexEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const label = normalize(e.label);
    const kw = normalize(e.keywords.join(" "));
    const desc = normalize(e.desc);
    const all = normalize([e.label, e.desc, e.keywords.join(" "), e.page ?? ""].join(" "));
    if (!tokens.every((t) => all.includes(t))) return;
    let score = 0;
    for (const t of tokens) {
      if (label.includes(t)) score += 3;
      if (kw.includes(t)) score += 2;
      if (desc.includes(t)) score += 1;
    }
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.e);
}
