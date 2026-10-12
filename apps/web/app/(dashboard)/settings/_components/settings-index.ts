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
  /** fulfilment | business | payments | selling | notifications | compliance | integrations | footer */
  groupKey: string;
  /** Breadcrumb tail, e.g. "Invoicing" (defaults to the label). */
  page?: string;
  keywords: string[];
  show?: "admin";
  /** fleet = routes/drivers on the plan; selfServe = Settings > Fulfillment is open to this tenant; counter = counter sales on. */
  needs?: "fleet" | "selfServe" | "counter";
  /** false = searchable but not a row in the hub/rail lists (Plan & billing lives in the Business card). */
  listed?: false;
  /** Filled by a later change; a row shows `affects ?? desc`. */
  affects?: string;
};

const R = "/settings/restrictions";

const ENTRIES: IndexEntry[] = [
  // ── How you sell ─────────────────────────────────────────────────────────────────────────
  {
    id: "fulfillment",
    kind: "item",
    label: "Fulfillment",
    desc: "How new orders reach your customers",
    href: "/settings?tab=fulfilment#delivery-method",
    groupKey: "fulfilment",
    needs: "selfServe",
    keywords: [
      "ship",
      "shipping",
      "carrier",
      "ups",
      "fedex",
      "pickup",
      "pick up",
      "our trucks",
      "in store",
    ],
  },
  {
    id: "counter-sales",
    kind: "item",
    label: "Counter sales",
    desc: "Walk-in sales, taken and paid on one screen",
    href: "/settings?tab=fulfilment#counter-sales",
    groupKey: "fulfilment",
    needs: "selfServe",
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
  {
    id: "counter-quick-keys",
    kind: "item",
    label: "Counter quick keys",
    desc: "Pin the products you ring up most",
    href: "/orders/counter-sale",
    groupKey: "fulfilment",
    needs: "counter",
    keywords: ["quick keys", "pins", "shortcuts", "buttons"],
  },
  {
    id: "day-close",
    kind: "item",
    label: "Day close & Z report",
    desc: "Count the drawer and close the day",
    href: "/orders/counter-sale",
    groupKey: "fulfilment",
    needs: "counter",
    keywords: ["z report", "end of day", "close day", "drawer", "cash drawer", "till", "register"],
  },
  {
    id: "delivery-method",
    kind: "card",
    label: "Delivery method",
    desc: "On our own trucks, by carrier or pickup",
    href: "/settings?tab=fulfilment#delivery-method",
    groupKey: "fulfilment",
    page: "Fulfillment",
    needs: "selfServe",
    keywords: [
      "carrier",
      "shipping",
      "ups",
      "fedex",
      "usps",
      "dhl",
      "tracking",
      "pickup",
      "trucks",
    ],
  },
  {
    id: "open-counter",
    kind: "card",
    label: "Open the Counter",
    desc: "Ring up a walk-in sale",
    href: "/orders/counter-sale",
    groupKey: "fulfilment",
    page: "Counter sales",
    needs: "counter",
    keywords: ["register", "till", "walk-in", "sale"],
  },
  {
    id: "backorder-visibility",
    kind: "card",
    label: "Backorder visibility",
    desc: "What customers see about backordered items",
    href: "#out-of-stock-ordering",
    groupKey: "fulfilment",
    page: "Out-of-stock ordering",
    keywords: ["backorder", "back order", "ships when restocked", "show", "hide", "customers see"],
  },
  {
    id: "info-pos-mode",
    kind: "info",
    label: "POS mode",
    desc: "Sell to a named customer and invoice now",
    answer:
      "Turn on POS mode in the New order window on the Orders screen. It books a named customer and invoices right away.",
    groupKey: "fulfilment",
    keywords: ["pos", "pos mode", "point of sale", "invoice now", "named customer"],
  },
  // ── Business & team ──────────────────────────────────────────────────────────────────────
  {
    id: "business-profile",
    kind: "item",
    label: "Business profile",
    desc: "Name, address, logo, receipt footer & default tax rate",
    href: "/settings?tab=profile",
    groupKey: "business",
    keywords: ["tax", "sales tax", "logo", "address", "phone", "company", "hours"],
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
      "permissions",
      "reset password",
    ],
  },
  // ── Invoicing & payments · Selling & pricing ─────────────────────────────────────────────
  {
    id: "invoicing",
    kind: "item",
    label: "Invoicing",
    desc: "Numbering, terms & default notes",
    href: "/settings?tab=invoicing",
    groupKey: "payments",
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
    groupKey: "payments",
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
    id: "restriction-rules",
    kind: "item",
    label: "Restriction rules",
    desc: "Rules that stop products being sold where they are banned",
    href: "/settings/restrictions/rules",
    groupKey: "selling",
    keywords: ["rules", "banned", "lift", "state", "restriction", "compliance"],
  },
  {
    id: "import-data",
    kind: "item",
    label: "Import data",
    desc: "CSV importers, numbering & finish setup",
    href: "/settings/import",
    groupKey: "integrations",
    keywords: ["numbering", "next number", "sequence", "csv", "upload"],
  },
  {
    id: "migration",
    kind: "item",
    label: "Migration",
    desc: "Move from Zoho, QuickBooks, CSV or paper",
    href: "/settings/migration",
    groupKey: "integrations",
    keywords: ["zoho", "quickbooks", "switch", "move"],
  },
  // ── Orders & stock ───────────────────────────────────────────────────────────────────────
  {
    id: "route-defaults",
    kind: "item",
    label: "Route defaults",
    desc: "Service time, start time, speed & depot location",
    href: "#route-defaults",
    groupKey: "fulfilment",
    needs: "fleet",
    keywords: ["route", "depot", "speed", "service time", "start time", "eta"],
  },
  {
    id: "out-of-stock-ordering",
    kind: "item",
    label: "Out-of-stock ordering",
    desc: "Let customers order items that are out of stock",
    href: "#out-of-stock-ordering",
    groupKey: "fulfilment",
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
    groupKey: "integrations",
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
    keywords: [
      "tobacco",
      "vape",
      "compliance",
      "tax rules",
      "subcategory",
      "restriction",
      "state",
      "blocked",
      "banned",
      "age",
    ],
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
    groupKey: "selling",
    show: "admin",
    keywords: ["restriction", "category", "tag", "compliance", "state", "blocked", "banned", "age"],
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
    groupKey: "business",
    listed: false,
    keywords: ["plan", "subscription", "add-on", "upgrade", "usage", "trial"],
  },
  {
    id: "billing-status",
    kind: "card",
    label: "Billing status",
    desc: "What you owe, autopay and the card on file",
    href: "/settings/billing",
    groupKey: "business",
    page: "Plan & billing",
    keywords: [
      "past due",
      "overdue",
      "card declined",
      "payment failed",
      "read only",
      "locked",
      "paused",
      "trial",
    ],
  },
  {
    id: "pay-bill",
    kind: "card",
    label: "Pay bill",
    desc: "Pay what you owe for your RouteFlow plan",
    href: "/settings/billing",
    groupKey: "business",
    page: "Plan & billing",
    keywords: ["pay", "pay now", "owed", "balance"],
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
    kind: "item",
    label: "Card payments",
    desc: "Take card payments from your buyers with Stripe",
    href: "/settings#card-payments",
    groupKey: "payments",
    page: "Card payments",
    keywords: ["stripe", "card", "credit card", "online payment", "pay online"],
  },
  {
    id: "tier-names",
    kind: "item",
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
    "time-zone",
    "Time zone",
    "The zone used for dates, day close and reports",
    "profile",
    "business",
    "Business profile",
    ["timezone", "tz", "clock", "utc"],
    { anchor: "settings-timezone" },
  ),
  ...card(
    "receipt-footer",
    "Receipt footer",
    "Text printed at the bottom of every receipt",
    "profile",
    "business",
    "Business profile",
    ["receipt", "footer", "print", "thank you"],
  ),
  ...card(
    "payment-terms",
    "Payment terms",
    "How many days customers have to pay",
    "invoicing",
    "payments",
    "Invoicing",
    ["terms", "net 30", "due date", "days to pay", "invoice"],
    { anchor: "invoice-due-days" },
  ),
  ...card(
    "original-price",
    "Show original price",
    "Show the list price next to a discounted price",
    "invoicing",
    "payments",
    "Invoicing",
    ["discount", "list price", "invoice"],
  ),
  ...card(
    "deposits",
    "Deposits",
    "Collect a deposit when the order is placed",
    "invoicing",
    "payments",
    "Invoicing",
    ["deposit", "prepay", "down payment", "invoice"],
  ),
  ...card(
    "invoice-numbering",
    "Invoice numbering",
    "Prefix and the next invoice number",
    "invoicing",
    "payments",
    "Invoicing",
    ["prefix", "invoice number", "next number", "sequence", "invoice"],
    { anchor: "invoice-number-prefix" },
  ),
  ...card(
    "invoice-defaults",
    "Invoice defaults",
    "Customer notes and terms & conditions on every invoice",
    "invoicing",
    "payments",
    "Invoicing",
    ["notes", "footer", "default notes", "terms", "conditions", "invoice"],
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
    "Warn when a price falls below your margin floor",
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
    "payments",
    "How to pay",
    ["remit", "check", "mail"],
  ),
  ...card(
    "payment-instructions",
    "Payment instructions",
    "Check, ACH, wire and notes shown on the buyer Payments page",
    "remittance",
    "payments",
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
    { show: "admin", anchor: "low-stock-digest" },
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
    "Switch between the operator view and the driver view",
    "account",
    "footer",
    undefined,
    ["driver", "act as driver", "driver view", "switch view", "app"],
    { needs: "fleet" },
  ),

  // ── Answers (not links) ──────────────────────────────────────────────────────────────────
  {
    id: "info-shipping-carrier",
    kind: "info",
    label: "Shipping carrier",
    desc: "Which carrier ships an order",
    answer: "You choose the carrier on each order when you mark it shipped.",
    groupKey: "fulfilment",
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
    groupKey: "fulfilment",
    keywords: ["last price", "previous price", "price history", "customer price"],
  },
  {
    id: "info-reorder-points",
    kind: "info",
    label: "Reorder points",
    desc: "When a product counts as low on stock",
    answer: "Set a reorder point on each product. The low-stock digest uses it.",
    groupKey: "fulfilment",
    keywords: ["low stock", "reorder", "digest", "stock alert", "inventory email"],
  },
  {
    id: "info-batch-ship",
    kind: "info",
    label: "Ship several orders at once",
    desc: "Mark many orders shipped together",
    answer: "Select orders on the Orders list, then choose Mark shipped.",
    groupKey: "fulfilment",
    keywords: ["bulk", "batch", "ship", "mark shipped", "tracking"],
  },
  {
    id: "info-counter-sales",
    kind: "info",
    label: "Counter sales",
    desc: "Sell to walk-in customers",
    answer:
      "Ring up walk-in customers from the Orders screen. Not there? Ask RouteFlow support to turn it on.",
    groupKey: "fulfilment",
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

/** A card that lives on a `?tab=` screen: deep-links to `#anchor` on that screen when it has one. */
function card(
  id: string,
  label: string,
  desc: string,
  tab: string,
  groupKey: string,
  page: string | undefined,
  keywords: string[],
  { anchor, ...extra }: Pick<IndexEntry, "show" | "needs"> & { anchor?: string } = {},
): IndexEntry[] {
  // Only a hash the page really renders (an id in the tab body) is linked; otherwise the plain tab.
  const href = `/settings?tab=${tab}${anchor ? `#${anchor}` : ""}`;
  return [{ id, kind: "card", label, desc, href, groupKey, page, keywords, ...extra }];
}

/** Carrier-only (fleet-off) accounts have no drivers: user management must not promise them. */
const USERS_DESC_NO_FLEET = "Team members, roles, passwords";

/** The entries a viewer can see: admin-only, fleet-only and flag-gated rows are dropped, never greyed out. */
export function buildIndex(o: {
  isAdmin: boolean;
  fleet: boolean;
  /** Settings > Fulfillment is open (GET /settings/fulfilment -> selfServe). Unknown = dark. */
  selfServe?: boolean;
  /** Counter sales are on (the counter capability). Unknown = dark. */
  counter?: boolean;
}): IndexEntry[] {
  const open = { fleet: o.fleet, selfServe: !!o.selfServe, counter: !!o.counter };
  return ENTRIES.filter((e) => (e.show === "admin" ? o.isAdmin : true))
    .filter((e) => (e.needs ? open[e.needs] : true))
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

/** Row order inside each hub/rail group (direction 2b); ids not listed sort last. */
export const GROUP_ROWS: Record<string, string[]> = {
  fulfilment: [
    "fulfillment",
    "counter-sales",
    "out-of-stock-ordering",
    "route-defaults",
    "counter-quick-keys",
    "day-close",
  ],
  business: ["business-profile", "user-management"],
  payments: ["invoicing", "how-to-pay", "card-payments"],
  selling: ["tier-names", "costing", "restrictions-selling", "restriction-rules", "product-labels"],
  notifications: ["notifications", "email-smtp"],
  compliance: ["regulated-sections", "restrictions-compliance"],
  integrations: [
    "claude-scanner",
    "gohighlevel",
    "import-data",
    "migration",
    "batch-invoice-import",
  ],
};
/** Counter-first (Sam) and fleet-first (Dana): the order changes, the membership never does. */
const FLEET_FIRST = ["route-defaults"];
const COUNTER_FIRST = ["counter-sales", "counter-quick-keys", "day-close"];

/** The list rows of one group, in order. */
export function listGroup(
  entries: IndexEntry[],
  key: string,
  o: { fleet: boolean; counter: boolean },
): IndexEntry[] {
  const base = GROUP_ROWS[key] ?? [];
  const lead = key === "fulfilment" ? (o.fleet ? FLEET_FIRST : o.counter ? COUNTER_FIRST : []) : [];
  const order = [...lead, ...base.filter((id) => !lead.includes(id))];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return entries
    .filter((e) => e.kind === "item" && e.listed !== false && e.groupKey === key)
    .sort((a, b) => rank(a.id) - rank(b.id));
}

/** An in-page anchor ("#route-defaults") made absolute, so a row works from any settings page. */
export function rowHref(e: Pick<IndexEntry, "href">): string {
  const h = e.href ?? "/settings";
  return h.startsWith("#") ? `/settings${h}` : h;
}

/** Search for the UI: linked results first (best match, anchored target on ties), then plain answers; no repeats. */
export function searchSettings(q: string, entries: IndexEntry[]): IndexEntry[] {
  const hits = searchIndex(q, entries);
  const linked = hits.filter((e) => e.kind !== "info");
  const seen = new Set<string>();
  const out = linked.filter((e) => {
    const k = `${e.href}|${e.label}|${e.groupKey}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const labels = new Set(linked.map((e) => normalize(e.label)));
  // An answer a linked row already gives (same words) is dropped; the link is the better answer.
  return [...out, ...hits.filter((e) => e.kind === "info" && !labels.has(normalize(e.label)))];
}

/** The label cut into runs, marking the words the query matched ("Low-stock digest" / "low stock"). */
export function splitHighlight(label: string, q: string): { text: string; hit: boolean }[] {
  const words = q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return [{ text: label, hit: false }];
  return label
    .split(new RegExp(`(${words.join("|")})`, "gi"))
    .filter((t) => t !== "")
    .map((text) => ({ text, hit: words.includes(text.toLowerCase()) }));
}

function parseHref(href: string) {
  const [pq, h = ""] = href.split("#");
  const [p, qs = ""] = pq.split("?");
  return {
    path: p || "/settings",
    tab: new URLSearchParams(qs).get("tab"),
    hash: h ? `#${h}` : "",
  };
}

/** Which row(s) are open: by ?tab=, by sub-route, or (bare hub) by card hash. */
export function activeEntryIds(
  entries: IndexEntry[],
  loc: { pathname: string; tab: string | null; hash: string },
): string[] {
  const rows = entries
    .filter((e) => e.kind === "item" && e.href)
    .map((e) => ({ id: e.id, ...parseHref(e.href!) }));
  if (loc.pathname !== "/settings") {
    // Selling restrictions is listed in two groups; only the first is the open row.
    const hit = rows.find((r) => r.path === loc.pathname);
    return hit ? [hit.id] : [];
  }
  if (!loc.tab)
    return loc.hash
      ? rows.filter((r) => r.path === "/settings" && !r.tab && r.hash === loc.hash).map((r) => r.id)
      : [];
  const onTab = rows.filter((r) => r.path === "/settings" && r.tab === loc.tab);
  const exact = onTab.find((r) => r.hash && r.hash === loc.hash);
  const one = exact ?? onTab[0];
  return one ? [one.id] : [];
}
