import type { SubscriptionView } from "@routeflow/types";
import { billingCardModel } from "@/lib/billing-card-model";
import type { BannerRole } from "@/lib/subscription-banner-state";

/**
 * What each hub row says it is set to right now (trailing value) and what the Business card says about the
 * plan. Pure: every function takes whatever the query returned (possibly undefined, possibly a failed or
 * partial answer) and returns text only when it is certain; otherwise undefined and the row shows nothing.
 */

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

export const timeZoneValue = (s?: { timezone?: string | null } | null) => text(s?.timezone);

export function invoicingValue(
  invoice?: { defaultTerms?: string } | null,
  numbering?: { docType?: string; prefix?: string; configured?: boolean }[] | null,
): string | undefined {
  const terms = text(invoice?.defaultTerms);
  if (!terms) return undefined;
  const row = Array.isArray(numbering) ? numbering.find((n) => n.docType === "INVOICE") : undefined;
  const prefix = row?.configured ? text(row.prefix) : undefined;
  return prefix ? `${prefix} · ${terms}` : terms;
}

export function oversellValue(inv?: { buyerOversell?: string } | null): string | undefined {
  if (!inv?.buyerOversell) return undefined;
  return inv.buyerOversell === "backorder" ? "Allowed" : "Off";
}

export function routeValue(
  r?: { serviceTimeMinutes?: number; defaultStartTime?: string } | null,
): string | undefined {
  const start = text(r?.defaultStartTime);
  return typeof r?.serviceTimeMinutes === "number" && start
    ? `${r.serviceTimeMinutes} min · ${start}`
    : undefined;
}

export function stripeValue(s?: { connected?: boolean } | null): string | undefined {
  return typeof s?.connected === "boolean"
    ? s.connected
      ? "Connected"
      : "Not connected"
    : undefined;
}

export const counterValue = (on?: boolean) => (on === undefined ? undefined : on ? "On" : "Off");

export function peopleValue(n?: number): string | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? `${n} ${n === 1 ? "person" : "people"}`
    : undefined;
}

// ── Business card ────────────────────────────────────────────────────────────────────────────

export interface BusinessStatus {
  plan: string;
  pill: { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" } | null;
  /** "Pay $149.00": admins only, only while an invoice is owed (the billing model decides). */
  pay: { label: string; url?: string } | null;
  /** Payment is due, overdue or the workspace is read-only for it. */
  due: boolean;
  /** What the plan costs, exactly as the Billing page shows it ("$499/mo", "$4,990/yr", "Custom pricing"); null if unknown. */
  price?: string | null;
}

/** The Billing page's plan price line (settings/billing/page.tsx), so the hub card never shows a second figure. */
function planPrice(sub: SubscriptionView): string | null {
  if (sub.isCustom) return "Custom pricing";
  const n = sub.cycle === "ANNUAL" ? sub.annualPrice : sub.monthlyPrice;
  if (n == null) return null;
  const amount = n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return `$${amount}/${sub.cycle === "ANNUAL" ? "yr" : "mo"}`;
}

const DAY_MS = 86_400_000;

export function businessStatus(
  sub: SubscriptionView | null | undefined,
  role: BannerRole | null,
  now: Date = new Date(),
): BusinessStatus | null {
  const plan = text(sub?.planName);
  if (!sub || !role || !plan) return null;
  const price = planPrice(sub);
  const model = billingCardModel(sub, role, now);
  const owed = model?.state === "due" || model?.state === "overdue";
  const readOnly = sub.status === "READ_ONLY";
  const due = owed || (readOnly && sub.readOnlyReason === "payment_overdue");
  const pay = model?.pay ?? null;
  if (readOnly) return { plan, price, pill: { label: "Read-only", tone: "danger" }, pay, due };
  if (owed) {
    return { plan, price, pill: { label: "Payment due", tone: "warning" }, pay, due };
  }
  if (model?.state === "processing") {
    return {
      plan,
      price,
      pill: { label: "Payment processing", tone: "neutral" },
      pay: null,
      due: false,
    };
  }
  if (sub.status === "TRIAL") {
    const end = sub.trialEndsAt ? new Date(sub.trialEndsAt).getTime() : NaN;
    const days = Math.max(0, Math.ceil((end - now.getTime()) / DAY_MS));
    const label = Number.isNaN(end)
      ? "Trial"
      : `Trial · ${days} ${days === 1 ? "day" : "days"} left`;
    return { plan, price, pill: { label, tone: "info" }, pay: null, due: false };
  }
  const pill = sub.status === "ACTIVE" ? ({ label: "Active", tone: "success" } as const) : null;
  return { plan, price, pill, pay: null, due: false };
}

export interface AttentionItem {
  id: string;
  label: string;
  href: string;
}

/** The short "Needs attention" list on the 1440 hub. Admins only; a loading or failed read flags nothing. */
export function attentionItems(o: {
  isAdmin: boolean;
  status: BusinessStatus | null;
  remittance?: object | null;
  stripe?: { connected?: boolean; configured?: boolean } | null;
  /** The customers-without-a-state card's totals (GET .../unknown-state-customers); null/undefined while loading. */
  unknownState?: { customersTotal?: number; truncated?: boolean } | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  // apple-ux U1: the fix list lived only on Selling restrictions; it is raised here for admins AND operators (both may
  // fix states). A truncated sweep still raises it (never a silent all-clear).
  const n = o.unknownState?.customersTotal ?? 0;
  if (n > 0 || o.unknownState?.truncated) {
    items.push({
      id: "customers-without-state",
      label:
        n > 0
          ? `${n} ${n === 1 ? "customer needs" : "customers need"} a state`
          : "Some customers may need a state",
      href: "/settings/restrictions#customers-without-state",
    });
  }
  if (!o.isAdmin) return items;
  if (o.status?.due) {
    items.push({
      id: "billing",
      label:
        o.status.pill?.label === "Read-only"
          ? "Your workspace is read-only until the bill is paid"
          : "A payment is due",
      href: "/settings/billing",
    });
  }
  const r = o.remittance;
  if (
    r &&
    typeof r === "object" &&
    !Object.values(r as Record<string, unknown>).some((v) => text(v))
  ) {
    items.push({
      id: "how-to-pay",
      label: "Tell customers how to pay you",
      href: "/settings?tab=remittance",
    });
  }
  if (o.stripe?.connected === false && o.stripe.configured !== false) {
    items.push({
      id: "stripe",
      label: "Connect Stripe to take card payments",
      href: "/settings#card-payments",
    });
  }
  return items;
}
