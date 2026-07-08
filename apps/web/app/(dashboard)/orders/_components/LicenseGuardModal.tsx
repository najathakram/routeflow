"use client";

import * as React from "react";
import { ShieldAlert, KeyRound, FileWarning, Trash2 } from "lucide-react";
import { Modal, Button, Input, Select } from "@routeflow/ui/web";
import {
  useCreateAuthorization,
  useCreateAuthorizationOverride,
  type BlockedCategory,
} from "@/lib/api/authorizations";

const todayIso = () => new Date().toISOString().slice(0, 10);

const OVERRIDE_REASONS = [
  "License on file but not yet recorded",
  "Verbal confirmation from customer",
  "Time-sensitive / emergency order",
  "Other",
];

type Mode = "choose" | "capture" | "override";

/**
 * The regulated-sale license guard modal (W6b). Opened when the API rejects a sale
 * with 409 REGULATED_AUTH_REQUIRED. "One modal, three exits" (spec §2): capture the
 * license now (→ VERIFIED), accept seller responsibility (§8 override), or remove
 * the offending line(s). Reusable across the order builder (no orderId yet → UNTIL
 * scope) and the order-detail edit/promote flow (orderId known → ORDER scope).
 */
export function LicenseGuardModal({
  open,
  customerId,
  blocked,
  orderId,
  onResolved,
  onRemoveLines,
  onClose,
}: {
  open: boolean;
  customerId: string;
  blocked: BlockedCategory[];
  /** When known (order detail), the override scopes to this order; else a 24h window. */
  orderId?: string;
  /** Capture/override succeeded — the caller should retry the blocked action. */
  onResolved: () => void;
  /** Remove the cart lines in these categories (client-side). Omit to hide the
   *  "remove line(s)" exit (e.g. the order-detail page, where lines are removed via
   *  the edit UI instead). */
  onRemoveLines?: (categoryIds: string[]) => void;
  onClose: () => void;
}) {
  const create = useCreateAuthorization(customerId);
  const override = useCreateAuthorizationOverride(customerId);
  const [mode, setMode] = React.useState<Mode>("choose");
  const [error, setError] = React.useState<string | null>(null);
  const [licenses, setLicenses] = React.useState<
    Record<string, { number: string; expiresAt: string }>
  >({});
  const [reason, setReason] = React.useState(OVERRIDE_REASONS[0]);
  const [ack, setAck] = React.useState("");

  const reset = () => {
    setMode("choose");
    setError(null);
    setLicenses({});
    setReason(OVERRIDE_REASONS[0]);
    setAck("");
  };
  const close = () => {
    reset();
    onClose();
  };

  const setLicense = (id: string, patch: Partial<{ number: string; expiresAt: string }>) =>
    setLicenses((prev) => {
      const cur = prev[id] ?? { number: "", expiresAt: "" };
      return { ...prev, [id]: { ...cur, ...patch } };
    });

  const busy = create.isPending || override.isPending;

  const submitCapture = async () => {
    setError(null);
    for (const b of blocked) {
      const l = licenses[b.trackedCategoryId];
      if (!l?.number?.trim()) return setError(`Enter the ${b.categoryName} license number.`);
      if (!l?.expiresAt) return setError(`Enter the ${b.categoryName} expiry date.`);
      if (new Date(l.expiresAt) < new Date(todayIso()))
        return setError(`The ${b.categoryName} expiry date is in the past.`);
    }
    try {
      for (const b of blocked) {
        const l = licenses[b.trackedCategoryId];
        await create.mutateAsync({
          trackedCategoryId: b.trackedCategoryId,
          licenseNumber: l.number.trim(),
          expiresAt: new Date(l.expiresAt).toISOString(),
        });
      }
      reset();
      onResolved();
    } catch (e) {
      setError(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Could not save the license. Please try again.",
      );
    }
  };

  const submitOverride = async () => {
    setError(null);
    if (!ack.trim()) return setError("Type your business name to accept responsibility.");
    const scope = orderId
      ? `ORDER:${orderId}`
      : `UNTIL:${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()}`;
    try {
      for (const b of blocked) {
        await override.mutateAsync({
          trackedCategoryId: b.trackedCategoryId,
          reason,
          scope,
          acknowledgedTenant: ack.trim(),
        });
      }
      reset();
      onResolved();
    } catch (e) {
      setError(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          "Could not record the override. Please try again.",
      );
    }
  };

  const names = blocked.map((b) => b.categoryName).join(", ");

  const footer =
    mode === "choose" ? (
      <Button type="button" variant="secondary" onClick={close}>
        Cancel
      </Button>
    ) : mode === "capture" ? (
      <>
        <Button type="button" variant="secondary" onClick={() => setMode("choose")} disabled={busy}>
          Back
        </Button>
        <Button type="button" onClick={submitCapture} loading={busy}>
          Verify &amp; continue
        </Button>
      </>
    ) : (
      <>
        <Button type="button" variant="secondary" onClick={() => setMode("choose")} disabled={busy}>
          Back
        </Button>
        <Button type="button" variant="danger" onClick={submitOverride} loading={busy}>
          Accept responsibility &amp; continue
        </Button>
      </>
    );

  return (
    <Modal
      open={open}
      onClose={close}
      title="License required"
      description={`This sale includes regulated items (${names}) the customer isn't licensed for.`}
      className="max-w-lg"
      footer={footer}
    >
      {mode === "choose" && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-lg bg-warning-bg/50 p-3 text-xs text-navy/80">
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" />
            <span>
              {blocked.some((b) => b.reason === "EXPIRED")
                ? "A required license has expired. Choose how to proceed:"
                : "The customer has no verified license for these categories. Choose how to proceed:"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setMode("capture")}
            className="flex w-full items-start gap-3 rounded-lg border border-surface-border p-3 text-left hover:border-brand-500 hover:bg-surface-raised/50 transition-colors"
          >
            <KeyRound className="mt-0.5 h-5 w-5 flex-shrink-0 text-brand-500" />
            <span>
              <span className="block text-sm font-medium text-navy">Capture the license now</span>
              <span className="block text-xs text-navy/60">
                Record the customer&rsquo;s license — verifies them instantly.
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMode("override")}
            className="flex w-full items-start gap-3 rounded-lg border border-surface-border p-3 text-left hover:border-brand-500 hover:bg-surface-raised/50 transition-colors"
          >
            <FileWarning className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
            <span>
              <span className="block text-sm font-medium text-navy">Sell under responsibility</span>
              <span className="block text-xs text-navy/60">
                Proceed without a license on file — logged with your acknowledgment (§8).
              </span>
            </span>
          </button>
          {onRemoveLines && (
            <button
              type="button"
              onClick={() => {
                onRemoveLines?.(blocked.map((b) => b.trackedCategoryId));
                close();
              }}
              className="flex w-full items-start gap-3 rounded-lg border border-surface-border p-3 text-left hover:border-danger hover:bg-danger-bg/30 transition-colors"
            >
              <Trash2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" />
              <span>
                <span className="block text-sm font-medium text-navy">
                  Remove the regulated line(s)
                </span>
                <span className="block text-xs text-navy/60">
                  Drop {names} from this order and continue with the rest.
                </span>
              </span>
            </button>
          )}
        </div>
      )}

      {mode === "capture" && (
        <div className="space-y-4">
          {blocked.map((b) => (
            <div key={b.trackedCategoryId} className="rounded-lg border border-surface-border p-3">
              <p className="mb-2 text-sm font-medium text-navy">{b.categoryName}</p>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="License number"
                  value={licenses[b.trackedCategoryId]?.number ?? ""}
                  onChange={(e) => setLicense(b.trackedCategoryId, { number: e.target.value })}
                  placeholder="e.g. TOB-0099123"
                />
                <Input
                  label="Expiry date"
                  type="date"
                  min={todayIso()}
                  value={licenses[b.trackedCategoryId]?.expiresAt ?? ""}
                  onChange={(e) => setLicense(b.trackedCategoryId, { expiresAt: e.target.value })}
                />
              </div>
            </div>
          ))}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}

      {mode === "override" && (
        <div className="space-y-4">
          <Select
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            options={OVERRIDE_REASONS.map((r) => ({ value: r, label: r }))}
          />
          <Input
            label="Type your business name to accept responsibility"
            value={ack}
            onChange={(e) => setAck(e.target.value)}
            placeholder="Your business name"
          />
          <p className="text-xs text-navy/60">
            This is logged (who, when, customer, category, reason) and adds a footnote to the
            invoice. It {orderId ? "applies to this order only" : "applies for the next 24 hours"}{" "}
            and never unlocks the customer&rsquo;s buyer portal.
          </p>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
