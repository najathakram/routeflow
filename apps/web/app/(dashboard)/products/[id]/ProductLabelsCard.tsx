"use client";

import * as React from "react";
import { Loader2, Tag, X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { PortalLimitsRow } from "./PortalLimitsRow";
import {
  useProductCategories,
  useProductLabels,
  useRemoveProductLabel,
  useSetProductLabel,
} from "@/lib/api/product-labels";

// No error toasts here: the global MutationCache handler shows the server message once (B594).
const chip =
  "inline-flex items-center gap-1 rounded-full border border-surface-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-navy";

/**
 * Restriction labels on one product. A variant also shows what it inherits (the parent's EFFECTIVE
 * set) and can opt out with a recorded reason. An opt-out lifts only the inherited LABEL: a rule on
 * the parent product itself still applies, and moving the variant makes its opt-out inactive.
 * Writes are TENANT_ADMIN-only (server-enforced).
 */
export function ProductLabelsCard({ productId }: { productId: string }) {
  const isAdmin = useAuth().user?.role === "TENANT_ADMIN";
  const { toast } = useToast();
  const { data, isLoading, isError } = useProductLabels(productId);
  const { data: categories = [], isError: categoriesFailed } = useProductCategories();
  const setLabel = useSetProductLabel(productId);
  const removeLabel = useRemoveProductLabel(productId);
  const [pickId, setPickId] = React.useState("");
  const [optOutId, setOptOutId] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");

  if (isLoading)
    return <Loader2 className="mx-auto my-4 h-5 w-5 animate-spin" aria-label="Loading" />;
  if (isError || !data) {
    return (
      <p className="rounded-xl border border-surface-border bg-white p-4 text-sm text-danger">
        Couldn&apos;t load labels.
      </p>
    );
  }

  const own = data.own.filter((l) => l.mode === "INCLUDE");
  const optOuts = new Map(
    data.own.filter((l) => l.mode === "EXCLUDE").map((l) => [l.categoryId, l]),
  );
  const taken = new Set(data.own.map((l) => l.categoryId));
  const addable = categories.filter((c) => !taken.has(c.id));
  const busy = setLabel.isPending || removeLabel.isPending;
  const optOutName = data.inherited.find((l) => l.categoryId === optOutId)?.categoryName;

  // `undoOptOut`: deleting an opt-out row RE-APPLIES the inherited restriction, so the message must
  // not say "removed" (that reads as the restriction being lifted, the opposite of what happened).
  const remove = (categoryId: string, name: string, undoOptOut = false) =>
    removeLabel.mutate(
      { categoryId },
      {
        onSuccess: () =>
          toast({
            title: undoOptOut ? `${name} applies to this variant again` : `${name} removed`,
            variant: "success",
          }),
      },
    );
  const submitOptOut = () =>
    optOutId &&
    reason.trim() &&
    setLabel.mutate(
      { categoryId: optOutId, mode: "EXCLUDE", reason: reason.trim() },
      { onSuccess: () => setOptOutId(null) },
    );

  return (
    <div className="rounded-xl border border-surface-border bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-navy">
          <Tag className="h-4 w-4 text-brand-600" aria-hidden /> Restriction labels
        </h3>
      </div>

      {!data.ancestryResolvable && (
        <p role="alert" className="mb-2 text-xs text-danger">
          This product&apos;s parent chain can&apos;t be resolved, so selling restrictions will
          block it until that is fixed.
        </p>
      )}
      {own.length === 0 && data.inherited.length === 0 ? (
        <p className="text-sm text-navy/60">No labels. This product is not covered by any label.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="Labels on this product">
          {own.map((l) => (
            <li key={l.id} className={chip}>
              {l.categoryName}
              {isAdmin && (
                <button
                  type="button"
                  aria-label={`Remove ${l.categoryName}`}
                  disabled={busy}
                  onClick={() => remove(l.categoryId, l.categoryName)}
                >
                  <X className="h-3 w-3 text-navy/50 hover:text-danger" />
                </button>
              )}
            </li>
          ))}
          {data.inherited.map((l) => {
            const out = optOuts.get(l.categoryId);
            const active = out?.optOutActive === true;
            return (
              <li
                key={`inh-${l.categoryId}`}
                className={`${chip} ${active ? "border-dashed opacity-70" : ""}`}
              >
                <span className={active ? "line-through" : ""}>{l.categoryName}</span>
                <span className="text-[11px] font-normal text-navy/50">
                  {active ? "opted out" : out ? "opt-out inactive: parent changed" : "from parent"}
                </span>
                {isAdmin && (
                  <button
                    type="button"
                    className="text-[11px] font-medium text-brand-600 hover:underline disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      active
                        ? remove(l.categoryId, l.categoryName, true)
                        : (setOptOutId(l.categoryId), setReason(""))
                    }
                  >
                    {active ? "Undo opt-out" : out ? "Opt out again" : "Opt out"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {optOutId && (
        <div className="mt-3 rounded-lg border border-surface-border bg-surface-raised/40 p-3">
          <label htmlFor="optout-reason" className="text-sm font-medium text-navy">
            Why does this variant opt out of {optOutName}?
          </label>
          <input
            id="optout-reason"
            autoFocus
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" ? submitOptOut() : e.key === "Escape" && setOptOutId(null)
            }
            placeholder="e.g. THC-free formulation"
            className="mt-1 h-10 w-full rounded border border-surface-border px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-navy/60">
            This lifts the inherited label for this variant only, and is recorded. A restriction
            that targets the parent product itself still applies.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              onClick={submitOptOut}
              loading={setLabel.isPending}
              disabled={!reason.trim()}
            >
              Confirm opt-out
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOptOutId(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="mt-3 flex items-center gap-2">
          <select
            aria-label="Add a label"
            disabled={categoriesFailed}
            value={pickId}
            onChange={(e) => setPickId(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">
              {categoriesFailed
                ? "Couldn't load labels to add"
                : addable.length === 0
                  ? "No more labels to add"
                  : "Add a label…"}
            </option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!pickId || busy}
            onClick={() =>
              setLabel.mutate(
                { categoryId: pickId, mode: "INCLUDE" },
                { onSuccess: () => setPickId("") },
              )
            }
          >
            Add
          </Button>
        </div>
      )}
      <PortalLimitsRow productId={productId} />
    </div>
  );
}
