"use client";

import * as React from "react";
import Link from "next/link";
import {
  fetchBusinessCapabilities,
  type BusinessCapabilities,
} from "@/lib/platform-admin/readiness-contract";
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

const CAN_SELL_STATUSES = ["TRIAL", "ACTIVE"];

/** The page's own Admin Account read: the card never fetches it (one source, no stale copy). */
export type ReadinessAdmin = { status?: string } | null;
export type AdminReadState = "loading" | "loaded" | "failed";

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

function buildRows(
  tenant: ReadinessTenant,
  caps: BusinessCapabilities,
  admin: ReadinessAdmin,
  adminState: AdminReadState,
): Row[] {
  const name = tenant.businessName ?? tenant.name;
  const base = `/admin/tenants/${tenant.id}`;
  const onTrial = tenant.status === "TRIAL";
  const canSell = CAN_SELL_STATUSES.includes(tenant.status);
  const hasAdmin = admin !== null && (admin.status === undefined || admin.status === "ACTIVE");
  const adminVerdict: Verdict = adminState !== "loaded" ? "unknown" : hasAdmin ? "pass" : "fail";
  const products = tenant.counts?.products;
  // One counter row, straight from the server's answer: the card never re-derives it.
  const counter: Verdict = caps.counterCapability !== "off" ? "pass" : "fail";

  return [
    {
      key: "admin",
      label: "Has an admin",
      verdict: adminVerdict,
      link:
        adminVerdict !== "fail"
          ? undefined
          : {
              href: `${base}?focus=admin-account`,
              text: "Create admin",
              aria: `Create admin for ${name}`,
            },
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
      key: "counter",
      label: "Sells at the counter",
      verdict: counter,
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
 * "Ready to take a sale?": the first card on the tenant Overview. Read-only; it composes the page's Admin Account read (a prop), the
 * detail's own status/trial/product count, and the server's one capability answer (GET business-capabilities), so a failed or
 * missing read is "Not checked", never green. A business that has not chosen how it sells gets one neutral line (no warnings).
 */
export function ReadinessCard({
  tenant,
  admin,
  adminState,
}: {
  tenant: ReadinessTenant;
  /** The page's loaded admin (null = none); a failed read keeps the row "Not checked". */
  admin: ReadinessAdmin;
  adminState: AdminReadState;
}) {
  const [caps, setCaps] = React.useState<BusinessCapabilities | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const load = React.useCallback(() => {
    setFailed(false);
    setCaps(null);
    fetchBusinessCapabilities(tenant.id)
      .then(setCaps)
      .catch(() => setFailed(true));
  }, [tenant.id]);

  React.useEffect(() => {
    load();
  }, [load]);

  // Delivery or shipping with no counter: nothing here applies to this business.
  if (caps?.configured && caps.counterCapability === "off") return null;

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
  if (caps && !caps.configured) {
    // D7: nothing is chosen yet. One neutral sentence, ready or not is not the question; it does not wait for the admin read.
    const name = tenant.businessName ?? tenant.name;
    return (
      <AdminCard title={title} className="lg:col-span-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-300">
          <span aria-hidden="true" className="text-slate-400">
            {STATUS_ICON.info}
          </span>
          <span>Choose how this business sells.</span>
          <Link
            href={`/admin/tenants/${tenant.id}?tab=setup&focus=capabilities`}
            scroll={false}
            aria-label={`Choose how ${name} sells`}
            className="admin-tap-text ml-auto text-indigo-400 hover:underline"
          >
            Choose
          </Link>
        </p>
      </AdminCard>
    );
  }
  if (!caps || adminState === "loading") {
    // One row until the capabilities answer, then the rows that are about to render.
    const skeletonRows = caps ? buildRows(tenant, caps, admin, adminState).length : 1;
    return (
      <AdminCard title={title} className="lg:col-span-2">
        <div aria-busy="true" className="flex flex-col gap-2">
          {Array.from({ length: skeletonRows }, (_, i) => (
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

  const rows = buildRows(tenant, caps, admin, adminState);
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
                <Link
                  href={r.link.href}
                  scroll={false}
                  aria-label={r.link.aria}
                  className="admin-tap-text ml-auto text-indigo-400 hover:underline"
                >
                  {r.link.text}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </AdminCard>
  );
}
