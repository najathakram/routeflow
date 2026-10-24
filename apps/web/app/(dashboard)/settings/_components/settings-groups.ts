import {
  Bell,
  Building2,
  Calculator,
  CreditCard,
  FileText,
  Landmark,
  Layers,
  Mail,
  Package,
  Plug,
  Receipt,
  ScanLine,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Store,
  Tag,
  Truck,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";

/** The 7 hub groups (direction 2b), in order. Rows come from the settings index; this is the chrome. */
export type GroupMeta = { key: string; title: string; icon: LucideIcon };

export const GROUP_META: GroupMeta[] = [
  { key: "fulfilment", title: "How you sell", icon: Store },
  { key: "business", title: "Business & team", icon: Building2 },
  { key: "payments", title: "Invoicing & payments", icon: Landmark },
  { key: "selling", title: "Selling & pricing", icon: ShoppingBag },
  { key: "notifications", title: "Notifications", icon: Bell },
  { key: "compliance", title: "Compliance", icon: ShieldCheck },
  { key: "integrations", title: "Integrations & import", icon: Sparkles },
];

/** Breadcrumb names, including the My account footer. */
export const GROUP_TITLES: Record<string, string> = {
  ...Object.fromEntries(GROUP_META.map((g) => [g.key, g.title])),
  footer: "My account",
};

/** One glyph per row (accent glyph on an accent-soft tile); a row without one wears its group's. */
export const ROW_ICONS: Record<string, LucideIcon> = {
  fulfillment: Truck,
  "counter-sales": Store,
  "out-of-stock-ordering": Package,
  "counter-quick-keys": Layers,
  "day-close": Receipt,
  "business-profile": Building2,
  "user-management": Users,
  invoicing: FileText,
  "how-to-pay": Landmark,
  "card-payments": CreditCard,
  "tier-names": Layers,
  costing: Calculator,
  "product-labels": Tag,
  "email-smtp": Mail,
  "claude-scanner": ScanLine,
  "import-data": Upload,
  gohighlevel: Plug,
};

export const CHIPS: { label: string; href: string }[] = [
  { label: "Invoicing", href: "/settings?tab=invoicing" },
  { label: "User management", href: "/settings?tab=users" },
  { label: "Import", href: "/settings/import" },
  { label: "Notifications", href: "/settings?tab=notifications" },
];
