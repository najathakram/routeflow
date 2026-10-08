"use client";

import * as React from "react";
import type { CounterSalesMode, FulfilmentMode } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";
import { fetchTenantFeaturesEffective } from "@/lib/platform-admin/features";
import { AdminCard } from "../../../../_components/AdminCard";

/** The slice of the tenant detail the card reads. `counts.products` may be absent (an older API): "Not checked". */
export interface ReadinessTenant {
  id: string;
  name: string;
  businessName: string | null;
  status: string;
  trialEndsAt: string | null;
  counts: { products?: number } | null;
}

type Verdict = "pass" | "fail" | "unknown" | "info";

interface Row {
  key: string;
  label: string;
  verdict: Verdict;
  note?: string;
  link?: { href: string; text: string; aria: string };
  /** Extra plain line under the label (the product row's "who adds products"). */
  detail?: string;
}

const IN_STORE_MODES: readonly FulfilmentMode[] = ["pickup", "pickup_ship"];
const COUNTER_ON: CounterSalesMode = "on";
const CAN_SELL_STATUSES = ["TRIAL", "ACTIVE"];

interface Data {
  admin: { status?: string } | null;
  /** Stored fulfilment_model / counter_sales; null = the effective read had no such row (not checked). */
  fulfilment: string | null;
  counter: string | null;
}

/** Same derivation as fulfilment-capability.ts: in-store modes always have the counter; counter_sales "on" adds it. */
function counterCapability(
  fulfilment: string,
  counterSales: string,
): "always" | "optional" | "off" {
  if ((IN_STORE_MODES as readonly string[]).includes(fulfilment)) return "always";
  return counterSales === COUNTER_ON ? "optional" : "off";
}

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

/** Relevant when counter selling is intended or no profile is set yet; delivery/shipping-only tenants skip it. */
function isRelevant(d: Data): boolean {
  if (d.fulfilment === null) return true; // can't tell: show, never hide on a guess
  if (d.fulfilment === "unset") return true;
  if ((IN_STORE_MODES as readonly string[]).includes(d.fulfilment)) return true;
  return d.counter === COUNTER_ON;
}

function buildRows(tenant: ReadinessTenant, d: Data): Row[] {
  const name = tenant.businessName ?? tenant.name;
  const base = `/admin/tenants/${tenant.id}`;
  const onTrial = tenant.status === "TRIAL";
  const canSell = CAN_SELL_STATUSES.includes(tenant.status);
  const hasAdmin =
    d.admin !== null && (d.admin.status === undefined || d.admin.status === "ACTIVE");
  const products = tenant.counts?.products;
  const sellsInStore =
    d.fulfilment === null
      ? "unknown"
      : (IN_STORE_MODES as readonly string[]).includes(d.fulfilment)
        ? "pass"
        : "fail";
  const counter: Verdict =
    d.fulfilment === null || d.counter === null
      ? "unknown"
      : counterCapability(d.fulfilment, d.counter) !== "off"
        ? "pass"
        : "fail";

  return [
    {
      key: "admin",
      label: "Has an admin",
      verdict: hasAdmin ? "pass" : "fail",
      link: hasAdmin
        ? undefined
        : { href: "#admin-account", text: "Create admin", aria: `Create admin for ${name}` },
    },
    {
      key: "account",
      label: "Account can sell",
      verdict: canSell ? "pass" : "fail",
      note:
        onTrial && tenant.trialEndsAt ? `Trial ends ${shortDate(tenant.trialEndsAt)}` : undefined,
      link: canSell
        ? undefined
        : { href: `${base}?tab=billing`, text: "Activate", aria: `Activate ${name}` },
    },
    {
      key: "store",
      label: "Sells in store",
      verdict: sellsInStore,
      link:
        sellsInStore === "fail"
          ? {
              href: `${base}?tab=setup`,
              text: "Set up",
              aria: `Set up in-store selling for ${name}`,
            }
          : undefined,
    },
    {
      key: "counter",
      label: "Counter sales is on",
      verdict: counter,
      link:
        counter === "fail"
          ? {
              href: `${base}?tab=setup#features`,
              text: "Set up",
              aria: `Set up counter sales for ${name}`,
            }
          : undefined,
    },
    {
      key: "products",
      label: "Has at least one product",
      verdict: products === undefined ? "unknown" : products > 0 ? "pass" : "fail",
      detail: products === 0 ? `${name} adds products in Products.` : undefined,
    },
    {
      key: "payment",
      label: "Payment at the till: cash, card, check and on account all work.",
      verdict: "info",
      detail: "Nothing to set up.",
    },
  ];
}

const STATUS_TEXT: Record<Verdict, string> = {
  pass: "Ready",
  fail: "Not ready",
  unknown: "Not checked",
  info: "Info",
};
const STATUS_ICON: Record<Verdict, string> = { pass: "✓", fail: "!", unknown: "?", info: "i" };
const STATUS_CLASS: Record<Verdict, string> = {
  pass: "text-green-400",
  fail: "text-amber-400",
  unknown: "text-slate-400",
  info: "text-slate-400",
};

/**
 * "Ready to take a sale?": the first card on the tenant Overview. Read-only; it composes the Admin Account read, the
 * detail's own status/trial/product count, and the stored fulfilment_model / counter_sales modes (the effective trace),
 * so a failed or missing read is "Not checked", never green.
 */
export function ReadinessCard({ tenant }: { tenant: ReadinessTenant }) {
  const [data, setData] = React.useState<Data | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(() => {
    setFailed(false);
    setData(null);
    Promise.all([
      superAdminClient.get(`/platform-admin/tenants/${tenant.id}/admin`),
      fetchTenantFeaturesEffective(tenant.id),
    ])
      .then(([adminRes, effective]) => {
        const byKey = new Map((Array.isArray(effective) ? effective : []).map((f) => [f.key, f]));
        setData({
          admin: adminRes.data?.admin ?? null,
          fulfilment: byKey.get("fulfilment_model")?.mode?.value ?? null,
          counter: byKey.get("counter_sales")?.mode?.value ?? null,
        });
      })
      .catch(() => setFailed(true));
  }, [tenant.id]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (data && !isRelevant(data)) return null;

  const title = "Ready to take a sale?";
  if (failed) {
    return (
      <AdminCard title={title} className="lg:col-span-2">
        <div role="alert" className="flex items-center gap-3 text-sm text-amber-400">
          <span>Couldn&apos;t check this tenant.</span>
          <button
            type="button"
            onClick={load}
            className="admin-tap-text rounded-lg border border-slate-600 px-3 py-1.5 text-slate-200 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      </AdminCard>
    );
  }
  if (!data) {
    return (
      <AdminCard title={title} className="lg:col-span-2">
        <div aria-busy="true" className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              data-testid="readiness-skeleton"
              className="h-6 animate-pulse rounded bg-slate-700/50 motion-reduce:animate-none"
            />
          ))}
        </div>
      </AdminCard>
    );
  }

  const rows = buildRows(tenant, data);
  const allGreen = rows.every((r) => r.verdict === "pass" || r.verdict === "info");
  const showRows = !allGreen || open;

  return (
    <AdminCard
      title={title}
      className="lg:col-span-2"
      actions={
        allGreen ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="admin-tap-text text-sm text-indigo-400 hover:underline"
          >
            {open ? "Hide details" : "Show details"}
          </button>
        ) : undefined
      }
    >
      {allGreen && (
        <p className="mb-2 text-sm font-medium text-green-400">
          <span aria-hidden="true">✓ </span>Ready to take a sale
        </p>
      )}
      {showRows && (
        <ul className="flex flex-col divide-y divide-slate-700/60">
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span
                className={`inline-flex min-w-[6.5rem] items-center gap-1.5 ${STATUS_CLASS[r.verdict]}`}
              >
                <span aria-hidden="true">{STATUS_ICON[r.verdict]}</span>
                <span>{STATUS_TEXT[r.verdict]}</span>
              </span>
              <span className="text-white">{r.label}</span>
              {r.note && <span className="text-slate-400">{r.note}</span>}
              {r.detail && <span className="text-slate-400">{r.detail}</span>}
              {r.link && (
                <a
                  href={r.link.href}
                  aria-label={r.link.aria}
                  className="admin-tap-text ml-auto text-indigo-400 hover:underline"
                >
                  {r.link.text}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </AdminCard>
  );
}
