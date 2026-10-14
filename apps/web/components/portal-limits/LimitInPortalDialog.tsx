"use client";

import * as React from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { StatePicker } from "@/app/(dashboard)/settings/restrictions/rules/_components/StatePicker";
import { liftBatchRequest, useBulkLimit } from "@/lib/api/portal-limits";
import { useUnknownStateBuckets } from "@/lib/api/unknown-state";
import { totalWithoutState } from "@/lib/unknown-state";
import { useRestrictionsSettings } from "@/lib/api/restrictions-settings";
import { useProductCategories } from "@/lib/api/product-labels";
import { WriteButton } from "@/lib/read-only-gate";
import { useAuth } from "@/lib/auth-context";
import { ASK_ACCOUNT_ADMIN, mayHideFromAllPortal } from "@/lib/portal-hide-admin";
import {
  LIMIT_MAX,
  LIMIT_SAVE_FAILED,
  LIMIT_TOO_MANY,
  UNDO_REASON,
  UNDO_VISIBLE_MS,
  buildBulkRequest,
  dialogTitle,
  doneTitle,
  liveLine,
  noStateLine,
  primaryLabel,
  undoneTitle,
  type LimitScope,
} from "@/lib/portal-limits";

const REVIEW_HREF = "/settings/restrictions#customers-without-state";
const LIMITS_HREF = "/settings/restrictions/rules";
const FORM_ID = "limit-in-portal-form";

/**
 * "Limit N products in your portal" (spec §2): one dialog for the products list and the category row. One primary
 * action, whose label tracks the choice; errors keep the input; success closes and toasts with Undo + View limits.
 * The primary sits in the pinned footer so it stays visible on a short phone.
 */
export function LimitInPortalDialog({
  open,
  scope: baseScope,
  onClose,
  onDone,
  pickCategory = false,
}: {
  open: boolean;
  scope: LimitScope;
  onClose: () => void;
  onDone?: () => void;
  /** Offer a whole-category scope: always from "Select all in category", and from the over-200 cap sentence. */
  pickCategory?: boolean;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const bulk = useBulkLimit();
  const unknown = useUnknownStateBuckets(1);
  const settings = useRestrictionsSettings();
  const [everyone, setEveryone] = React.useState(false);
  const [states, setStates] = React.useState<string[]>([]);
  const [note, setNote] = React.useState("");
  const [legalBan, setLegalBan] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const mayHideAll = mayHideFromAllPortal(useAuth().user?.role);
  const [picked, setPicked] = React.useState<{
    id: string;
    name: string;
    productCount: number;
  } | null>(null);

  React.useEffect(() => {
    if (open) {
      setPicked(null);
      setEveryone(false);
      setStates([]);
      setNote("");
      setLegalBan(false);
      setFailed(false);
    }
  }, [open]);

  const scope: LimitScope = picked
    ? {
        kind: "category",
        categoryId: picked.id,
        categoryName: picked.name,
        productCount: picked.productCount,
      }
    : baseScope;
  const chosen = everyone ? null : states;
  const count = scope.kind === "products" ? scope.productIds.length : 0;
  const tooMany = scope.kind === "products" && count > LIMIT_MAX;
  const needsCategory = scope.kind === "products" && pickCategory && !picked && count === 0;
  const showPicker = pickCategory && (tooMany || needsCategory || !!picked);
  // L5: an all-portal hide is account-admin only; the server refuses it too.
  const needsAdmin = !mayHideAll && everyone;
  const ready = !tooMany && !needsCategory && !needsAdmin && (everyone || states.length > 0);
  const noState = totalWithoutState(unknown.data);
  const line = liveLine(scope, chosen, legalBan);
  const enforcementOff = settings.data ? settings.data.enabled === false : false;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || bulk.isPending) return;
    setFailed(false);
    const request = buildBulkRequest({ scope, states: chosen, legalBan, note });
    bulk.mutate(request, {
      onSuccess: (res) => {
        const createdIds = res.createdIds ?? [];
        const changed = res.created > 0 && createdIds.length > 0;
        toast({
          title: doneTitle(scope, chosen, res.created, res.skipped),
          variant: "success",
          duration: UNDO_VISIBLE_MS,
          secondaryAction: { label: "View limits", onClick: () => router.push(LIMITS_HREF) },
          // Undo is a plain call: this component is usually gone (selection cleared) by the time it is clicked.
          ...(changed
            ? {
                action: {
                  label: "Undo",
                  onClick: () => {
                    liftBatchRequest({ ids: createdIds, reason: UNDO_REASON })
                      .then((r) => {
                        qc.invalidateQueries({ queryKey: ["selling-restrictions"] });
                        toast({
                          title: undoneTitle(chosen, r.lifted ?? createdIds.length, scope),
                          variant: "success",
                        });
                      })
                      .catch(() =>
                        toast({
                          title: "Couldn't undo. Nothing was changed.",
                          variant: "error",
                        }),
                      );
                  },
                },
              }
            : {}),
        });
        onDone?.();
        onClose();
      },
      onError: () => setFailed(true),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={needsCategory ? "Limit a whole category in your portal" : dialogTitle(scope)}
      scroll
      footer={
        <>
          <NextLink href={LIMITS_HREF} className="mr-auto text-xs text-navy/60 hover:underline">
            View all limits
          </NextLink>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <WriteButton type="submit" form={FORM_ID} disabled={!ready} loading={bulk.isPending}>
            {primaryLabel(chosen)}
          </WriteButton>
        </>
      }
    >
      <form
        id={FORM_ID}
        onSubmit={submit}
        noValidate
        className="space-y-4"
        data-testid="limit-in-portal-dialog"
      >
        {showPicker && (
          <CategoryPick
            value={picked?.id ?? ""}
            emptyLabel={tooMany ? "Limit a whole category instead…" : "Choose a category…"}
            onPick={setPicked}
          />
        )}

        <fieldset className="space-y-2">
          <legend className="sr-only">Who should not see them</legend>
          <label className="flex items-start gap-2 text-sm text-navy">
            <input
              type="radio"
              name="limit-who"
              checked={!everyone}
              onChange={() => setEveryone(false)}
            />
            <span>Hide from customers in certain states</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-navy">
            <input
              type="radio"
              name="limit-who"
              checked={everyone}
              disabled={!mayHideAll}
              onChange={() => setEveryone(true)}
            />
            <span>
              Hide from all portal customers
              {!mayHideAll && (
                <span className="block text-xs text-navy/60">{ASK_ACCOUNT_ADMIN}</span>
              )}
            </span>
          </label>
        </fieldset>

        {!everyone && (
          <div>
            <p className="mb-1 text-sm font-medium text-navy">Which states?</p>
            <StatePicker value={states} onChange={setStates} />
          </div>
        )}

        {tooMany ? (
          <p role="alert" className="text-sm text-danger">
            {LIMIT_TOO_MANY}
          </p>
        ) : (
          line && (
            <div className="space-y-1" aria-live="polite">
              <p className="text-sm text-navy">{line}</p>
              {!everyone && !legalBan && noState > 0 && (
                <p className="text-sm text-navy/70">
                  {noStateLine(noState)}{" "}
                  <NextLink href={REVIEW_HREF} className="font-medium text-brand-600 underline">
                    Review
                  </NextLink>
                </p>
              )}
            </div>
          )
        )}

        <label className="block text-sm font-medium text-navy">
          Note (optional)
          <input
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why, e.g. not licensed in TX"
            className="mt-1 h-10 w-full rounded border border-surface-border px-3 text-sm font-normal text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </label>

        <div>
          <label className="flex items-start gap-2 text-sm text-navy">
            <input
              type="checkbox"
              checked={legalBan}
              onChange={(e) => setLegalBan(e.target.checked)}
            />
            <span>Legal ban — also block staff orders and invoices</span>
          </label>
          {legalBan && enforcementOff && (
            <p className="mt-1 pl-6 text-xs text-navy/70">
              Staff orders are blocked once enforcement is on.{" "}
              <NextLink
                href="/settings/restrictions"
                className="font-medium text-brand-600 underline"
              >
                Turn on
              </NextLink>
            </p>
          )}
        </div>

        {failed && (
          <p role="alert" className="text-sm text-danger">
            {LIMIT_SAVE_FAILED}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** The whole-category chooser; mounted only when offered, so the dialog costs no label read otherwise. */
function CategoryPick({
  value,
  emptyLabel,
  onPick,
}: {
  value: string;
  emptyLabel: string;
  onPick: (c: { id: string; name: string; productCount: number } | null) => void;
}) {
  const categories = useProductCategories();
  const list = (categories.data ?? []).filter((c) => !c.archivedAt);
  return (
    <label className="block text-sm font-medium text-navy">
      Which category?
      <select
        value={value}
        onChange={(e) => {
          const c = list.find((x) => x.id === e.target.value);
          onPick(c ? { id: c.id, name: c.name, productCount: c.productCount } : null);
        }}
        className="mt-1 h-10 w-full rounded border border-surface-border bg-white px-2 text-sm font-normal text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
        <option value="">{emptyLabel}</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.productCount})
          </option>
        ))}
      </select>
    </label>
  );
}
