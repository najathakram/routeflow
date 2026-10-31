"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, Card, useToast } from "@routeflow/ui/web";
import { PREF } from "@routeflow/types";
import { useStaffEmailSettings, useUpdateStaffEmailSettings } from "@/lib/api/messaging";
import { usePreferences, useSavePreferences } from "@/lib/api/users";
import { MiniSwitch } from "./MiniSwitch";

/**
 * SA-1063: customer order emails to the office (Settings → Notifications, administrators only).
 * Two rows: the business's switch (a tenant policy, written through `PUT /messaging/staff-email-settings`)
 * and the administrator's own opt-out (one preference pair, "false" opts out, absent = on). The
 * personal row only shows while the business switch is on: opting out of something that is off says nothing.
 */
export function StaffOrderEmailCard() {
  const { toast } = useToast();
  const settings = useStaffEmailSettings();
  const update = useUpdateStaffEmailSettings();
  const prefs = usePreferences();
  const savePrefs = useSavePreferences();

  const data = settings.data;
  const on = data?.policyMode === "on";
  // The business chose "on" but nothing is leaving yet (the platform has not started sending).
  const notStarted = on && data?.effectiveMode !== "on";
  const recipients = data?.recipients ?? [];
  const personalOn = prefs.data?.[PREF.staffOrderEmail] !== "false";

  function onToggleBusiness() {
    update.mutate(
      { mode: on ? "off" : "on" },
      {
        onSuccess: () =>
          toast({
            variant: "success",
            title: on ? "Customer order emails turned off" : "Customer order emails turned on",
          }),
        onError: () => toast({ variant: "error", title: "Couldn't save. Try again." }),
      },
    );
  }

  function onTogglePersonal() {
    const next = personalOn ? "false" : "true";
    savePrefs.mutate(
      { [PREF.staffOrderEmail]: next, [PREF.staffBuyerChangeEmail]: next },
      {
        onSuccess: () => toast({ variant: "success", title: "Your preference is saved" }),
        onError: () => toast({ variant: "error", title: "Couldn't save your preference" }),
      },
    );
  }

  return (
    <Card id="customer-order-emails" title="Customer order emails">
      {settings.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-navy/60">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : settings.isError || !data ? (
        <div className="flex items-center justify-between gap-3 text-sm text-navy/70">
          <span>Couldn&apos;t load this setting.</span>
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11"
            onClick={() => settings.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium text-navy">
                Email your team about customer orders
              </div>
              <div className="text-xs text-navy/70">
                Sends an email when a customer places, changes, or cancels an order.
              </div>
            </div>
            <MiniSwitch
              checked={on}
              disabled={update.isPending}
              ariaLabel="Email your team about customer orders"
              onToggle={onToggleBusiness}
            />
          </div>

          {recipients.length > 0 && (
            <p className="break-words text-xs text-navy/70">
              <span className="font-medium text-navy">Goes to</span> {recipients.join(", ")}
            </p>
          )}
          {recipients.length === 0 && (
            <p role="status" className="text-xs text-navy/70">
              No administrator has an email address. Add one to send these emails.
            </p>
          )}
          {notStarted && (
            <p role="status" className="text-xs text-navy/70">
              Saved. Emails haven&apos;t started yet.
            </p>
          )}

          {on && (
            <div className="flex items-center justify-between gap-4 border-t border-surface-border pt-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-navy">Email me about customer orders</div>
                <div className="text-xs text-navy/70">Applies to you only.</div>
              </div>
              <MiniSwitch
                checked={personalOn}
                disabled={savePrefs.isPending || prefs.isLoading}
                ariaLabel="Email me about customer orders"
                onToggle={onTogglePersonal}
              />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
