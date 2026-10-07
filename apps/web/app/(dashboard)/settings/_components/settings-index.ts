/**
 * The Settings search index (IA PR1): ONE data file that both the hub cards and the search read,
 * so what you can search can't drift from what you can click.
 *
 * Three kinds of entry:
 *  - "item": a hub link today (the cards on bare /settings render from these, in this order)
 *  - "card": a card inside a tab or page, or a card that sits below the hub cards. Searchable only.
 *  - "info": an answer to a question people search for (no setting behind it, no link)
 *
 * Search words come from label + description + keywords + page. The group TITLE is deliberately not
 * searched: "stock" used to land on the "Orders & stock" group, which holds no stock settings.
 */

export type IndexEntry = {
  /** Stable kebab id: "route-defaults", "card-payments", "invoicing-payment-terms". */
  id: string;
  kind: "item" | "card" | "info";
  /** For an info row this is the question. */
  label: string;
  desc: string;
  /** Absent for kind "info". */
  href?: string;
  /** kind "info" only: the answer, shown in place of a description. */
  answer?: string;
  /** Today's hub group keys, plus "footer" for My account. */
  groupKey: string;
  /** Breadcrumb tail for a card entry, e.g. "Invoicing". Searched too. */
  page?: string;
  keywords: string[];
  /** Same meaning as the hub always had: only admins see it (Regulated, Product labels). */
  show?: "admin";
  /** Hidden when the tenant has no fleet. The hub passes `fleet` from its own fleet gate. */
  needs?: "fleet";
  /** A one-line "what this affects"; a later PR fills it. A result row shows `affects ?? desc`. */
  affects?: string;
};

/** Group titles by key. The hub's group cards and the breadcrumb of a result row read these. */
export const GROUP_TITLES: Record<string, string> = {
  business: "Business & team",
  selling: "Selling & catalog",
  orders: "Orders & stock",
  notifications: "Notifications",
  compliance: "Compliance",
  integrations: "Integrations",
  billing: "Billing",
  footer: "My account",
};

export const ROUTE_DEFAULTS_ID = "route-defaults";
export const ROUTE_DEFAULTS_HREF = "#route-defaults";

const item = (
  e: Omit<IndexEntry, "kind" | "id"> & { id: string; kind?: IndexEntry["kind"] },
): IndexEntry => ({ kind: "item", ...e });
const card = (e: Omit<IndexEntry, "kind">): IndexEntry => ({ ...e, kind: "card" });
const info = (e: Omit<IndexEntry, "kind" | "desc" | "href"> & { desc?: string }): IndexEntry => ({
  desc: "",
  ...e,
  kind: "info",
});

const RESTRICTION_WORDS = [
  "restriction",
  "state",
  "blocked",
  "banned",
  "age",
  "tobacco",
  "vape",
  "compliance",
];

/** Every entry, unfiltered. `buildIndex` applies the role and fleet gates. */
const ALL_ENTRIES: IndexEntry[] = [
  // ── Hub items (the cards on bare /settings), in today's order ─────────────────────────────
  item({
    id: "business-profile",
    label: "Business profile",
    desc: "Name, address, logo & default tax rate",
    href: "/settings?tab=profile",
    groupKey: "business",
    keywords: ["tax", "sales tax", "logo", "address", "phone", "company"],
  }),
  item({
    id: "user-management",
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
  }),
  item({
    id: "invoicing",
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
  }),
  item({
    id: "costing",
    label: "Costing",
    desc: "Costing method & margin floors",
    href: "/settings?tab=costing",
    groupKey: "selling",
    keywords: ["margin", "cogs", "fifo", "cost"],
  }),
  item({
    id: "how-to-pay",
    label: "How to pay",
    desc: "Remit-to & payment instructions",
    href: "/settings?tab=remittance",
    groupKey: "selling",
    keywords: ["bank", "remit", "check", "ach", "wire", "zelle"],
  }),
  item({
    id: "restrictions-selling",
    label: "Selling restrictions",
    desc: "Block restricted products by the customer's state",
    href: "/settings/restrictions",
    groupKey: "selling",
    keywords: RESTRICTION_WORDS,
  }),
  item({
    id: "import-data",
    label: "Import data",
    desc: "CSV importers, numbering & finish setup",
    href: "/settings/import",
    groupKey: "selling",
    keywords: ["numbering", "next number", "sequence"],
  }),
  item({
    id: "migration",
    label: "Migration",
    desc: "Move from Zoho, QuickBooks, CSV or paper",
    href: "/settings/migration",
    groupKey: "selling",
    keywords: ["zoho", "quickbooks", "csv", "move", "switch"],
  }),
  item({
    id: ROUTE_DEFAULTS_ID,
    label: "Route defaults",
    desc: "Service time, start time, speed & depot location",
    href: ROUTE_DEFAULTS_HREF,
    groupKey: "orders",
    needs: "fleet",
    keywords: ["route", "depot", "speed", "service time", "start time", "eta"],
  }),
  item({
    id: "batch-invoice-import",
    label: "Batch invoice import",
    desc: "Scan a stack of bills/photos into invoices",
    href: "/settings/batch-import",
    groupKey: "orders",
    keywords: ["scan", "bills", "photos", "ocr"],
  }),
  item({
    id: "notifications",
    label: "Notifications",
    desc: "Event rules, message templates, quiet hours & low-stock digest",
    href: "/settings?tab=notifications",
    groupKey: "notifications",
    keywords: ["sms", "whatsapp", "text", "template", "quiet hours", "reminder"],
  }),
  item({
    id: "email-smtp",
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
  }),
  item({
    id: "regulated-sections",
    label: "Regulated sections",
    desc: "Tracked categories, tax rules & subcategories",
    href: "/settings?tab=regulated",
    groupKey: "compliance",
    show: "admin",
    keywords: ["tobacco", "vape", "tracked", "category", "compliance"],
  }),
  item({
    id: "restrictions-compliance",
    label: "Selling restrictions",
    desc: "Block restricted products by the customer's state",
    href: "/settings/restrictions",
    groupKey: "compliance",
    keywords: RESTRICTION_WORDS,
  }),
  item({
    id: "product-labels",
    label: "Product labels",
    desc: "Restriction categories applied to products",
    href: "/settings/product-categories",
    groupKey: "compliance",
    show: "admin",
    keywords: RESTRICTION_WORDS,
  }),
  item({
    id: "claude-ai-scanner",
    label: "Claude AI scanner",
    desc: "API key for invoice/bill scanning",
    href: "/settings?tab=integrations",
    groupKey: "integrations",
    keywords: ["ai", "ocr", "scan", "anthropic", "claude", "photo"],
  }),
  item({
    id: "gohighlevel",
    label: "GoHighLevel",
    desc: "Create customers from won leads",
    href: "/settings?tab=gohighlevel",
    groupKey: "integrations",
    keywords: ["crm", "leads", "ghl"],
  }),
  item({
    id: "plan-billing",
    label: "Plan & billing",
    desc: "Subscription, usage & add-ons",
    href: "/settings/billing",
    groupKey: "billing",
    keywords: ["plan", "subscription", "add-on", "upgrade", "usage"],
  }),

  // ── Cards that sit below the hub cards, or on a page of their own ─────────────────────────
  card({
    id: "card-payments",
    label: "Card payments",
    desc: "Connect Stripe so customers can pay invoices online",
    href: "/settings#card-payments",
    groupKey: "billing",
    keywords: ["stripe", "card", "credit card", "online payment", "pay online"],
  }),
  card({
    id: "tier-names",
    label: "Pricing tier names",
    desc: "Rename your customer price levels",
    href: "/settings#tier-names",
    groupKey: "selling",
    keywords: ["tier", "price level", "price list", "wholesale price"],
  }),
  card({
    id: "my-account",
    label: "My account",
    desc: "Password, active sessions, Google sign-in & driver access",
    href: "/settings?tab=account",
    groupKey: "footer",
    keywords: ["password", "sign in", "sign-in", "google", "sessions", "2-step"],
  }),

  // ── Cards inside a tab (the #anchors become real in a later PR; a hash is harmless until then) ──
  card({
    id: "profile-business-info",
    label: "Business information",
    desc: "Your business name, phone and email",
    href: "/settings?tab=profile#business-info",
    groupKey: "business",
    page: "Business profile",
    keywords: ["company", "phone", "name"],
  }),
  card({
    id: "profile-business-address",
    label: "Business address",
    desc: "The address printed on your documents",
    href: "/settings?tab=profile#business-address",
    groupKey: "business",
    page: "Business profile",
    keywords: ["address", "city", "state", "zip"],
  }),
  card({
    id: "profile-logo",
    label: "Logo",
    desc: "The logo on invoices and emails",
    href: "/settings?tab=profile#logo",
    groupKey: "business",
    page: "Business profile",
    keywords: ["image", "brand"],
  }),
  card({
    id: "profile-tax",
    label: "Tax settings",
    desc: "The default tax rate on new orders and invoices",
    href: "/settings?tab=profile#tax",
    groupKey: "business",
    page: "Business profile",
    keywords: ["tax", "sales tax"],
  }),
  card({
    id: "invoicing-payment-terms",
    label: "Payment terms",
    desc: "Net 30, Net 15 and the like: when an invoice is due",
    href: "/settings?tab=invoicing#payment-terms",
    groupKey: "selling",
    page: "Invoicing",
    keywords: ["terms", "net 30", "due date", "days to pay"],
  }),
  card({
    id: "invoicing-original-price",
    label: "Show original price on discounted lines",
    desc: "Print the list price next to a discounted price",
    href: "/settings?tab=invoicing#original-price",
    groupKey: "selling",
    page: "Invoicing",
    keywords: ["discount", "list price"],
  }),
  card({
    id: "invoicing-deposits",
    label: "Deposits",
    desc: "The default deposit percentage on new invoices",
    href: "/settings?tab=invoicing#deposits",
    groupKey: "selling",
    page: "Invoicing",
    keywords: ["deposit", "prepay", "advance"],
  }),
  card({
    id: "invoicing-numbering",
    label: "Invoice numbering",
    desc: "The prefix and next number on your invoices",
    href: "/settings?tab=invoicing#invoice-numbering",
    groupKey: "selling",
    page: "Invoicing",
    keywords: ["prefix", "invoice number", "numbering", "next number"],
  }),
  card({
    id: "invoicing-defaults",
    label: "Default invoice notes",
    desc: "The note and footer new invoices start with",
    href: "/settings?tab=invoicing#invoice-defaults",
    groupKey: "selling",
    page: "Invoicing",
    keywords: ["notes", "footer", "message"],
  }),
  card({
    id: "costing-method",
    label: "Costing method",
    desc: "How product cost is worked out",
    href: "/settings?tab=costing#costing-method",
    groupKey: "selling",
    page: "Costing",
    keywords: ["fifo", "average", "cogs", "cost"],
  }),
  card({
    id: "costing-margin-floors",
    label: "Margin floors",
    desc: "The lowest margin you will sell at",
    href: "/settings?tab=costing#margin-floors",
    groupKey: "selling",
    page: "Costing",
    keywords: ["margin", "minimum", "price floor"],
  }),
  card({
    id: "remittance-remit-to",
    label: "Remit-to details",
    desc: "Where and how customers send payment",
    href: "/settings?tab=remittance#remit-to",
    groupKey: "selling",
    page: "How to pay",
    keywords: ["remit", "mail", "check"],
  }),
  card({
    id: "remittance-payment-instructions",
    label: "Payment instructions",
    desc: "Bank, ACH or wire details shown on invoices",
    href: "/settings?tab=remittance#payment-instructions",
    groupKey: "selling",
    page: "How to pay",
    keywords: ["bank", "ach", "wire", "zelle"],
  }),
  card({
    id: "notifications-rules",
    label: "Notification rules",
    desc: "Which events send a message, and to whom",
    href: "/settings?tab=notifications#notification-rules",
    groupKey: "notifications",
    page: "Notifications",
    keywords: ["sms", "whatsapp", "email", "template", "event"],
  }),
  card({
    id: "notifications-quiet-hours",
    label: "Quiet hours",
    desc: "When messages wait instead of sending",
    href: "/settings?tab=notifications#quiet-hours",
    groupKey: "notifications",
    page: "Notifications",
    keywords: ["night", "do not disturb", "schedule"],
  }),
  card({
    id: "notifications-low-stock-digest",
    label: "Low-stock digest",
    desc: "A daily email listing products running low",
    href: "/settings?tab=notifications#low-stock-digest",
    groupKey: "notifications",
    page: "Notifications",
    keywords: ["low stock", "reorder", "digest", "stock alert", "inventory email"],
  }),
  card({
    id: "notifications-push",
    label: "Push notifications",
    desc: "Alerts on your phone and in the browser",
    href: "/settings?tab=notifications#push",
    groupKey: "notifications",
    page: "Notifications",
    keywords: ["phone", "browser", "alert"],
  }),
  card({
    id: "notifications-delivery-health",
    label: "Delivery health",
    desc: "Whether your messages are reaching people",
    href: "/settings?tab=notifications#delivery-health",
    groupKey: "notifications",
    page: "Notifications",
    keywords: ["bounce", "failed", "deliverability"],
  }),
  card({
    id: "email-smtp-sender",
    label: "SMTP sender",
    desc: "The server and address your emails go out from",
    href: "/settings?tab=email#smtp",
    groupKey: "notifications",
    page: "Email (SMTP)",
    keywords: ["smtp", "sender", "from address"],
  }),
  card({
    id: "email-sending-domain",
    label: "Send from your own domain",
    desc: "Prove your domain so emails are not marked as spam",
    href: "/settings?tab=email#sending-domain",
    groupKey: "notifications",
    page: "Email (SMTP)",
    keywords: ["sending domain", "domain", "dkim", "spf", "deliverability"],
  }),
  card({
    id: "email-mailbox",
    label: "Connect your email",
    desc: "Send customer emails from your own Gmail or Outlook account",
    href: "/settings?tab=email#mailbox",
    groupKey: "notifications",
    page: "Email (SMTP)",
    keywords: ["mailbox", "gmail", "outlook", "inbox", "connect email"],
  }),
  card({
    id: "account-password",
    label: "Change password",
    desc: "Set a new password for your sign-in",
    href: "/settings?tab=account#password",
    groupKey: "footer",
    page: "My account",
    keywords: ["password", "sign in", "reset"],
  }),
  card({
    id: "account-google-sign-in",
    label: "Google sign-in",
    desc: "Link your Google account to sign in with it",
    href: "/settings?tab=account#google-sign-in",
    groupKey: "footer",
    page: "My account",
    keywords: ["google", "link", "sign in"],
  }),
  card({
    id: "account-sessions",
    label: "Active sessions",
    desc: "Devices you are signed in on",
    href: "/settings?tab=account#sessions",
    groupKey: "footer",
    page: "My account",
    keywords: ["sessions", "devices", "sign out", "2-step"],
  }),
  card({
    id: "account-driver-access",
    label: "Driver access",
    desc: "Switch between operator and driver views without a separate account",
    href: "/settings?tab=account#driver-access",
    groupKey: "footer",
    page: "My account",
    keywords: ["driver", "app"],
  }),

  // ── Answers people search for (not settings) ──────────────────────────────────────────────
  info({
    id: "info-shipping-carrier",
    label: "Shipping carrier",
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
  }),
  info({
    id: "info-ship-several",
    label: "Ship several orders at once",
    answer: "Select orders on the Orders list, then choose Mark shipped.",
    groupKey: "orders",
    keywords: ["batch", "bulk", "ship", "shipping", "tracking", "packing slip"],
  }),
  info({
    id: "info-counter-sales",
    label: "Counter sales",
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
  }),
  info({
    id: "info-last-price",
    label: "Last price a customer paid",
    answer: "New orders fill in the last price you gave this customer.",
    groupKey: "orders",
    keywords: ["price", "last price", "reorder", "repeat"],
  }),
  info({
    id: "info-reorder-points",
    label: "Reorder points",
    answer: "Set a reorder point on each product. The low-stock digest uses it.",
    groupKey: "orders",
    keywords: ["low stock", "reorder", "digest", "stock alert", "inventory email", "stock"],
  }),
];

/** The entries this person can see: admin-only ones hidden from operators, fleet-only ones when no fleet. */
export function buildIndex(o: { isAdmin: boolean; fleet: boolean }): IndexEntry[] {
  return ALL_ENTRIES.filter(
    (e) => (e.show === "admin" ? o.isAdmin : true) && (e.needs === "fleet" ? o.fleet : true),
  );
}

/**
 * Lower-case, fold every run of punctuation to one space, trim, and drop ONE trailing "s" from a
 * word longer than three letters: "Low-stock" -> "low stock", "restrictions" -> "restriction".
 * Both the query and the searched text go through it, so they meet in the middle.
 */
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

const hay = (...parts: (string | undefined)[]) => normalize(parts.filter(Boolean).join(" "));

/**
 * Every query word must appear somewhere in label + description + keywords + page (the words may
 * come from different fields). Ranked: a label hit scores 3, a keyword hit 2, a description hit 1,
 * summed over the words; ties keep index order. An empty query is no search at all.
 */
export function searchIndex(q: string, entries: IndexEntry[]): IndexEntry[] {
  const tokens = normalize(q).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const scored: { e: IndexEntry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const label = hay(e.label);
    const keywords = hay(e.keywords.join(" "));
    const desc = hay(e.desc, e.answer);
    const all = hay(e.label, e.desc, e.answer, e.keywords.join(" "), e.page);
    if (!tokens.every((t) => all.includes(t))) return;
    const score = tokens.reduce(
      (sum, t) =>
        sum + (label.includes(t) ? 3 : keywords.includes(t) ? 2 : desc.includes(t) ? 1 : 0),
      0,
    );
    scored.push({ e, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.e);
}

/** "Selling & catalog › Invoicing": the group, then the page it lives on (or the entry itself). */
export function breadcrumb(e: IndexEntry): string {
  return `${GROUP_TITLES[e.groupKey] ?? e.groupKey} › ${e.page ?? e.label}`;
}
