"use client";

import * as React from "react";
import { Lock, Sparkles, AlertTriangle, Loader2 } from "lucide-react";
import { Card, Button, Modal, cn } from "@routeflow/ui/web";
import type { PlanGateBody } from "@/lib/plan-gate";

/**
 * The three plan-gate surfaces (plan-gating-wiring.md §1). A gated endpoint returns
 * a PLAN_GATE 403; parse it with parsePlanGate() and render the matching component.
 */

/** LOCKED_PAGE — ghost the feature and overlay an upsell card. */
export function LockedPage({
  gate,
  title,
  secondary,
  children,
}: {
  gate: PlanGateBody;
  title?: string;
  /** Optional plain line rendered under the CTA (e.g. lite-L2's "Want it? Contact us to
   *  upgrade." — no link target invented; the existing "See plans" CTA is the only action). */
  secondary?: string;
  children?: React.ReactNode;
}) {
  const u = gate.upgrade;
  const cta =
    u?.addonSku != null
      ? `Add ${u.addonSku}${u.addonMonthlyPrice ? ` · $${u.addonMonthlyPrice}/mo` : ""}`
      : u?.planKey != null
        ? `Upgrade to ${u.planKey}${u.planMonthlyPrice ? ` · $${u.planMonthlyPrice}/mo` : ""}`
        : "See plans";
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none select-none opacity-40 blur-[1px]">
        {children}
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <Card className="max-w-md p-6 text-center shadow-lg ring-1 ring-slate-200">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <Lock className="h-5 w-5" />
          </div>
          <h3 className="text-lg font-semibold text-slate-900">{title ?? "Not on your plan"}</h3>
          <p className="mt-1 text-sm text-slate-500">{gate.message}</p>
          <a href="/choose-plan">
            <Button className="mt-4">
              <Sparkles className="mr-1 h-4 w-4" /> {cta}
            </Button>
          </a>
          {secondary && <p className="mt-2 text-sm text-slate-500">{secondary}</p>}
        </Card>
      </div>
    </div>
  );
}

/** GRACE — a soft cap started a 7-day grace; nothing is blocked yet. */
export function GraceBanner({
  daysLeft,
  message,
  onResolve,
}: {
  daysLeft: number;
  message?: string;
  onResolve?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
      <span className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {message ?? "You've exceeded a plan limit."} Nothing is blocked —{" "}
        <strong>
          {daysLeft} day{daysLeft === 1 ? "" : "s"}
        </strong>{" "}
        to resolve.
      </span>
      {onResolve && (
        <Button size="sm" variant="secondary" onClick={onResolve}>
          Resolve now
        </Button>
      )}
    </div>
  );
}

/** INLINE_RESOLVE — enable an add-on inline, showing the prorated charge before confirm. */
export function InlineResolveModal({
  open,
  gate,
  prorated,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  gate: PlanGateBody;
  prorated?: number | null;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const u = gate.upgrade;
  return (
    <Modal open={open} onClose={onClose} title="Enable add-on">
      <p className="text-sm text-slate-600">{gate.message}</p>
      {u?.addonSku && (
        <div className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200">
          <div className="flex justify-between">
            <span className="text-slate-600">{u.addonSku}</span>
            <span className="tabular-nums text-slate-800">
              {u.addonMonthlyPrice ? `$${u.addonMonthlyPrice}/mo` : ""}
            </span>
          </div>
          {prorated != null && (
            <div className="mt-1 flex justify-between font-medium">
              <span>Prorated today</span>
              <span className="tabular-nums">${prorated.toFixed(2)}</span>
            </div>
          )}
        </div>
      )}
      <div className={cn("mt-4 flex justify-end gap-2")}>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Enable"}
        </Button>
      </div>
    </Modal>
  );
}
