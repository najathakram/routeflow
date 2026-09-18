"use client";

import * as React from "react";
import { AdminModal } from "../../../../_components/AdminModal";
import { enableTenantAddon, fetchTenantBillingInfo } from "@/lib/platform-admin/features";

type BillingCheck =
  { status: "loading" } | { status: "error" } | { status: "done"; stripeConfigured: boolean };

/** Explicit only — never defaults to either path (approved spec: "that must be an explicit
 *  choice, never a silent default"). */
type Choice = "stripe" | "free" | null;

export interface EnableAddonModalProps {
  open: boolean;
  onClose: () => void;
  tenantId: string;
  tenantLabel: string;
  addonKey: string;
  addonLabel: string;
  /** B519: set when this key's registry `requires` isn't satisfied for this tenant — a
   *  ready-to-render phrase (e.g. "Recurring routes or Order delivery"), already resolved to
   *  labels by the caller. Undefined/omitted = no unmet requirement (default; every other
   *  addon-row key is unaffected). */
  unmetRequirement?: string;
  /** Called after a successful enable so the console reloads effective state/badges. */
  onEnabled: () => void;
}

/** The Feature Console's "Enable as add-on" action (B2b) — writes ONLY to
 *  `POST /platform-admin/tenants/:id/addons/enable`, never to `/feature-overrides` (that
 *  path stays the "Customise" button's unbilled COMP override, untouched by this modal). */
export function EnableAddonModal({
  open,
  onClose,
  tenantId,
  tenantLabel,
  addonKey,
  addonLabel,
  unmetRequirement,
  onEnabled,
}: EnableAddonModalProps) {
  const [billing, setBilling] = React.useState<BillingCheck>({ status: "loading" });
  const [step, setStep] = React.useState<"choice" | "confirm">("choice");
  const [choice, setChoice] = React.useState<Choice>(null);
  const [priceId, setPriceId] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  // B519: same "explicit only, never a silent default" rule as the Stripe/free choice above —
  // an unmet requirement needs its own deliberate acknowledgment, not an implied one.
  const [ackUnmetRequirement, setAckUnmetRequirement] = React.useState(false);

  const loadBilling = React.useCallback(() => {
    setBilling({ status: "loading" });
    fetchTenantBillingInfo(tenantId)
      .then(({ stripeConfigured }) => setBilling({ status: "done", stripeConfigured }))
      .catch(() => setBilling({ status: "error" }));
  }, [tenantId]);

  React.useEffect(() => {
    if (!open) return;
    setStep("choice");
    setChoice(null);
    setPriceId("");
    setSubmitError(null);
    setSubmitting(false);
    setAckUnmetRequirement(false);
    loadBilling();
  }, [open, loadBilling]);

  // With Stripe not configured there is only one possible outcome (a free grant), so the
  // "explicit choice" requirement only applies while a real choice exists.
  const effectiveChoice: Choice =
    billing.status === "done" && !billing.stripeConfigured ? "free" : choice;
  const canContinue =
    billing.status === "done" &&
    (effectiveChoice === "free" || (effectiveChoice === "stripe" && priceId.trim().length > 0));

  async function handleConfirm() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await enableTenantAddon(
        tenantId,
        addonKey,
        effectiveChoice === "stripe" ? priceId.trim() : undefined,
      );
      onEnabled();
      onClose();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string | string[] } } };
      const message = err?.response?.data?.message;
      setSubmitError(
        Array.isArray(message)
          ? message.join("; ")
          : (message ?? "Could not enable that add-on. Try again."),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function renderChoiceStep() {
    if (billing.status === "loading") {
      return <p className="text-sm text-slate-400">Checking billing configuration...</p>;
    }
    if (billing.status === "error") {
      return (
        <div className="rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30">
          Could not check billing configuration. Try again.
        </div>
      );
    }
    if (!billing.stripeConfigured) {
      return (
        <p className="text-sm text-slate-300">
          Stripe is not configured for this environment — this will be a free grant, not billed.
        </p>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-300">
          Choose how <strong>{addonLabel}</strong> should be enabled for{" "}
          <strong>{tenantLabel}</strong>.
        </p>
        <label
          className={`flex flex-col gap-2 rounded-lg p-3 ring-1 ${
            choice === "stripe" ? "ring-indigo-500 bg-indigo-900/10" : "ring-slate-700"
          }`}
        >
          <span className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="radio"
              name="enable-addon-choice"
              checked={choice === "stripe"}
              onChange={() => setChoice("stripe")}
            />
            Bill via Stripe
          </span>
          {choice === "stripe" && (
            <input
              type="text"
              value={priceId}
              onChange={(e) => setPriceId(e.target.value)}
              placeholder="price_1234567890"
              aria-label="Stripe price ID"
              className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
          )}
        </label>
        <label
          className={`flex items-center gap-2 rounded-lg p-3 text-sm text-slate-200 ring-1 ${
            choice === "free" ? "ring-indigo-500 bg-indigo-900/10" : "ring-slate-700"
          }`}
        >
          <input
            type="radio"
            name="enable-addon-choice"
            checked={choice === "free"}
            onChange={() => setChoice("free")}
          />
          Grant without billing
        </label>
      </div>
    );
  }

  function renderConfirmStep() {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-300">
          This will enable <strong>{addonLabel}</strong> for tenant <strong>{tenantLabel}</strong>.
        </p>
        <p className="text-xs text-slate-500">
          {effectiveChoice === "stripe"
            ? `A Stripe subscription item will be created (price ${priceId.trim()}).`
            : "No Stripe subscription item will be created — this is a free grant."}
        </p>
        {unmetRequirement && (
          <div className="rounded-lg bg-amber-900/30 px-4 py-3 text-sm text-amber-200 ring-1 ring-amber-600/30">
            <p>
              <strong>{addonLabel}</strong> depends on <strong>{unmetRequirement}</strong>, which
              this tenant does not currently have. It will appear enabled while depending on
              something that isn&apos;t there.
            </p>
            <label className="mt-2 flex items-center gap-2 text-xs text-amber-100">
              <input
                type="checkbox"
                checked={ackUnmetRequirement}
                onChange={(e) => setAckUnmetRequirement(e.target.checked)}
              />
              I understand and want to enable it anyway
            </label>
          </div>
        )}
        {submitError && (
          <div className="rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30">
            {submitError}
          </div>
        )}
      </div>
    );
  }

  function renderFooter() {
    if (step === "choice") {
      return (
        <>
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            disabled={!canContinue}
            onClick={() => setStep("confirm")}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Continue
          </button>
        </>
      );
    }
    return (
      <>
        <button
          onClick={() => setStep("choice")}
          className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
          disabled={submitting}
        >
          Back
        </button>
        <button
          disabled={submitting || (!!unmetRequirement && !ackUnmetRequirement)}
          onClick={handleConfirm}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {submitting ? "Enabling..." : "Confirm"}
        </button>
      </>
    );
  }

  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={`Enable ${addonLabel} as an add-on`}
      footer={renderFooter()}
    >
      {step === "choice" ? renderChoiceStep() : renderConfirmStep()}
    </AdminModal>
  );
}
