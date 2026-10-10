"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, cn, useToast } from "@routeflow/ui/web";
import { PREF } from "@routeflow/types";
import { usePreferences, useSavePreferences } from "@/lib/api/users";

/**
 * Per-user opt-out for the daily low-stock digest email. Stored in
 * users/me/preferences as the string "true"/"false"; an absent value means ON
 * (only "false" opts out — see the API's low-stock-digest.service).
 */
const KEY = PREF.lowStockDigestEnabled;

export function LowStockDigestToggle() {
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = usePreferences();
  const save = useSavePreferences();
  const checked = data?.[KEY] !== "false";

  function onToggle() {
    save.mutate(
      { [KEY]: checked ? "false" : "true" },
      {
        onSuccess: () => toast({ variant: "success", title: "Low-stock digest preference saved" }),
        onError: () =>
          toast({ variant: "error", title: "Couldn't save your low-stock digest preference" }),
      },
    );
  }

  return (
    <Card title="Low-stock digest">
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-navy/60">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : isError ? (
        <div className="flex items-center justify-between gap-3 text-sm text-navy/70">
          <span>Couldn&apos;t load your notification preferences.</span>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-navy">Email me a low-stock digest</div>
            <div className="text-xs text-navy/55">
              A daily summary of products at or below their reorder point. Applies to you only.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label="Low-stock digest email"
            disabled={save.isPending}
            onClick={onToggle}
            className={cn(
              "relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              checked ? "bg-brand-500" : "bg-navy/20",
            )}
          >
            <span
              className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
                checked ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      )}
    </Card>
  );
}
