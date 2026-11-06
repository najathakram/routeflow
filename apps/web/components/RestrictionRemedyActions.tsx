"use client";

import * as React from "react";
import NextLink from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Select } from "@routeflow/ui/web";
import {
  NO_STORE_STATE_LINE,
  US_STATES,
  noStateOnFileLine,
  type RestrictionWarningLine,
} from "@routeflow/types";
import { useCustomer } from "@/lib/api/customers";
import { useCreateMinimalAddress, useSetAddressState } from "@/lib/api/unknown-state";
import {
  REMEDY_COPY,
  customerStateFix,
  remedyActions,
  type RemedyAction,
} from "@/lib/api/restriction-warning";

/** Where the store's own state is set (Settings > Business profile > Business address). */
export const STORE_STATE_HREF = "/settings?tab=profile#business-address";
/** The full "Customers without a state" fixer (several addresses, no single default). */
export const NO_STATE_FIXER_HREF = "/settings/restrictions";

/** The same teal ring the buttons and fields wear, so a keyboard user sees the remedy as a control (not the browser's thin default outline). */
const FOCUS_RING =
  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent";

const STATE_OPTIONS = US_STATES.map((s) => ({ value: s.code, label: `${s.code} — ${s.name}` }));

/**
 * Row 672 (SA-844): the secondary action beside "Sell anyway" on a warned line whose state can't be resolved. A customer
 * with no state gets the in-place fixer (one state field, then "Check the sale again" re-judges the same cart, no ack);
 * a store with no state links to Settings > Business address in a new tab so the cart is kept. Never instead of the
 * override: both stay on screen.
 */
export function RestrictionRemedyActions({
  lines,
  onRecheck,
}: {
  lines: readonly RestrictionWarningLine[];
  /** Re-run the save with no acknowledgement (the server judges the cart afresh). */
  onRecheck?: () => void;
}) {
  const actions = remedyActions(lines);
  if (actions.length === 0) return null;
  return (
    <div className="mt-4 space-y-2" aria-label="Fix the missing state">
      {actions.map((a) => (
        <RemedyAction key={keyOf(a)} action={a} onRecheck={onRecheck} />
      ))}
    </div>
  );
}

const keyOf = (a: RemedyAction) => (a.kind === "ADD_STORE_STATE" ? "store" : a.customerId);

function RemedyAction({ action, onRecheck }: { action: RemedyAction; onRecheck?: () => void }) {
  if (action.kind === "ADD_STORE_STATE") {
    return (
      <NextLink
        href={STORE_STATE_HREF}
        target="_blank"
        rel="noopener"
        className={`inline-flex min-h-11 items-center text-sm font-medium text-brand-600 underline md:min-h-0 ${FOCUS_RING}`}
      >
        {NO_STORE_STATE_LINE}
      </NextLink>
    );
  }
  return (
    <AddCustomerState
      customerId={action.customerId}
      addressId={action.addressId}
      onRecheck={onRecheck}
    />
  );
}

function AddCustomerState({
  customerId,
  addressId,
  onRecheck,
}: {
  customerId: string;
  /** The address the engine reads (server-named, SA-924); absent = create one or choose a default. */
  addressId?: string;
  onRecheck?: () => void;
}) {
  const qc = useQueryClient();
  const customer = useCustomer(customerId);
  const create = useCreateMinimalAddress();
  const setState = useSetAddressState();
  const [open, setOpen] = React.useState(false);
  const [state, setStateValue] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const panelId = React.useId();
  const stateRef = React.useRef<HTMLSelectElement>(null);
  const recheckRef = React.useRef<HTMLButtonElement>(null);
  // Set by the click that opens the fixer, so only a person's own opening moves focus (never a re-render).
  const focusStateField = React.useRef(false);

  // Opening the fixer lands on its State field: one Tab less, and a screen reader hears the field it just got.
  React.useEffect(() => {
    if (!open || !focusStateField.current) return;
    focusStateField.current = false;
    stateRef.current?.focus();
  }, [open]);
  // Saving replaces the Save button, so focus would fall to the dialog; hand it to the next step instead.
  React.useEffect(() => {
    if (saved) recheckRef.current?.focus();
  }, [saved]);

  const name: string = customer.data?.businessName ?? REMEDY_COPY.thisCustomer;
  const fix = customerStateFix(customer.data?.addresses ?? [], addressId);
  const saving = create.isPending || setState.isPending;

  const save = async () => {
    if (!state || saving) return;
    setFailed(false);
    try {
      if (fix.kind === "create") await create.mutateAsync({ customerId, state });
      else if (fix.kind === "setState")
        await setState.mutateAsync({
          customerId,
          addressId: fix.addressId,
          state,
          confirmReview: true,
        });
      else return;
      await qc.invalidateQueries({ queryKey: ["customers", customerId] });
      setSaved(true);
    } catch {
      setFailed(true);
    }
  };

  if (saved) {
    return (
      <div
        className="rounded-lg bg-success-bg px-3 py-2 text-sm text-navy"
        role="status"
        aria-live="polite"
      >
        <p>{REMEDY_COPY.saved}</p>
        {onRecheck && (
          <Button
            ref={recheckRef}
            variant="secondary"
            className="mt-2 max-md:min-h-11"
            onClick={onRecheck}
          >
            {REMEDY_COPY.checkAgain}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          focusStateField.current = !open;
          setOpen(!open);
        }}
        className={`inline-flex min-h-11 items-center text-left text-sm font-medium text-brand-600 underline md:min-h-0 ${FOCUS_RING}`}
      >
        {noStateOnFileLine(name)}
      </button>
      {open && (
        <div id={panelId} className="mt-2 rounded-lg border border-surface-border p-3">
          {fix.kind === "chooseDefault" ? (
            <p className="text-sm text-navy">
              {REMEDY_COPY.chooseDefault}{" "}
              <NextLink
                href={NO_STATE_FIXER_HREF}
                target="_blank"
                rel="noopener"
                className={`font-medium text-brand-600 underline ${FOCUS_RING}`}
              >
                {REMEDY_COPY.openFixer}
              </NextLink>
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1">
                <Select
                  ref={stateRef}
                  label={REMEDY_COPY.stateLabel}
                  placeholder="State…"
                  options={STATE_OPTIONS}
                  value={state}
                  onChange={(e) => setStateValue(e.target.value)}
                  error={failed ? REMEDY_COPY.failed : undefined}
                />
              </div>
              <Button
                className="max-md:min-h-11"
                disabled={!state || saving}
                onClick={() => void save()}
              >
                {saving ? REMEDY_COPY.saving : REMEDY_COPY.save}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
