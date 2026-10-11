"use client";

import * as React from "react";
import { Download, Lock } from "lucide-react";
import { Badge, Button, Modal, Textarea, useToast } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";
import { useAuth } from "@/lib/auth-context";
import {
  fetchRegulatedFilingUrl,
  useLockRegulatedFiling,
  type RegulatedFiling,
} from "@/lib/api/tracked-categories";

interface Props {
  filings: RegulatedFiling[];
  /** Show the "Category" column (index view). Omit for a single-section view. */
  showCategory?: boolean;
  /** Resolve a section id → display name (required when showCategory). */
  categoryName?: (id: string) => string;
  /** Optional copy for the empty state. */
  emptyHint?: React.ReactNode;
}

/**
 * Shared filings table for the regulated surfaces — the /compliance index (all
 * sections, with a Category column) and the per-section dashboard (one section).
 * Only CSV is offered; PDF generation hasn't shipped (pdfKey is always null).
 */
export function RegulatedFilingsTable({
  filings,
  showCategory = false,
  categoryName,
  emptyHint,
}: Props) {
  const { toast } = useToast();
  // B297 PR5: only a tenant admin may lock a filed period, with a reason; there is no unlock.
  const canLock = useAuth().user?.role === "TENANT_ADMIN";
  const lock = useLockRegulatedFiling();
  const [lockTarget, setLockTarget] = React.useState<RegulatedFiling | null>(null);
  const [reason, setReason] = React.useState("");

  const submitLock = () => {
    if (!lockTarget || reason.trim().length < 3) return;
    lock.mutate(
      { id: lockTarget.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast({ title: `Filing ${lockTarget.periodKey} locked`, variant: "success" });
          setLockTarget(null);
          setReason("");
        },
        onError: (e) =>
          toast({
            title: "Could not lock the filing",
            description: (e as Error)?.message,
            variant: "error",
          }),
      },
    );
  };

  const openFilingUrl = async (id: string) => {
    const url = await fetchRegulatedFilingUrl(id, "csv");
    window.open(url, "_blank", "noopener");
  };

  if (filings.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-8 text-center text-sm text-navy/70">
        {emptyHint ?? (
          <>
            No filings prepared yet. Use{" "}
            <span className="font-medium text-navy">Prepare filing</span> to generate one for the
            last completed period.
          </>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-surface-border text-left text-xs text-navy/60">
            <th className="py-2 pr-3 font-medium">Period</th>
            {showCategory && <th className="py-2 pr-3 font-medium">Category</th>}
            <th className="py-2 pr-3 text-right font-medium">Net sales</th>
            <th className="py-2 pr-3 text-right font-medium">Tax</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          {filings.map((f) => (
            <tr key={f.id} className="border-b border-surface-border/60 last:border-0">
              <td className="py-2 pr-3 font-medium text-navy">{f.periodKey}</td>
              {showCategory && (
                <td className="py-2 pr-3 text-navy/80">
                  {categoryName?.(f.trackedCategoryId) ?? "—"}
                </td>
              )}
              <td className="py-2 pr-3 text-right tabular-nums text-navy">
                {fmt(Number(f.totalNetSales))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-navy">
                {fmt(Number(f.totalCategoryTax))}
              </td>
              <td className="py-2 pr-3">
                {f.status === "LOCKED" ? (
                  <span
                    title={f.lockReason ?? undefined}
                    className="inline-flex items-center gap-1"
                  >
                    <Badge variant="neutral" label="Locked" />
                    <Lock className="h-3 w-3 text-navy/50" aria-hidden />
                  </span>
                ) : (
                  <Badge
                    variant={f.status === "GENERATED" ? "success" : "warning"}
                    label={f.status === "GENERATED" ? "Generated" : "Failed"}
                  />
                )}
              </td>
              <td className="py-2 text-right">
                {canLock && f.status === "GENERATED" && new Date(f.periodEnd) <= new Date() && (
                  <button
                    type="button"
                    onClick={() => setLockTarget(f)}
                    className="mr-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy hover:bg-surface-raised"
                  >
                    <Lock className="h-3.5 w-3.5" /> Lock
                  </button>
                )}
                {f.csvKey && (
                  <button
                    type="button"
                    onClick={() =>
                      openFilingUrl(f.id).catch(() =>
                        toast({ title: "Failed to open CSV", variant: "error" }),
                      )
                    }
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-600 hover:bg-surface-raised"
                  >
                    <Download className="h-3.5 w-3.5" /> CSV
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal
        open={lockTarget != null}
        onClose={() => {
          setLockTarget(null);
          setReason("");
        }}
        title={`Lock the ${lockTarget?.periodKey ?? ""} filing`}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setLockTarget(null)}
              disabled={lock.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={submitLock}
              loading={lock.isPending}
              disabled={reason.trim().length < 3}
            >
              Lock filing
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-navy/70">
          A locked filing is closed: it is never regenerated, changes that would move its
          period&apos;s money are refused, and it cannot be unlocked. Returns and credit notes book
          into the current period.
        </p>
        <Textarea
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Filed with the state on 10/20"
        />
      </Modal>
    </div>
  );
}
