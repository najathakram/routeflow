"use client";

import * as React from "react";
import { Card, useToast } from "@routeflow/ui/web";
import { PREF } from "@routeflow/types";
import { useAuth } from "@/lib/auth-context";
import { usePreferences, useSavePreferences } from "@/lib/api/users";
import { MiniSwitch } from "./MiniSwitch";

/**
 * W-1443 (SA-1516): "Copies of emails you send" (Settings → Notifications). One personal switch: when on, the
 * api emails the sender a private copy of every invoice they email to a customer (the customer sees nothing).
 * OPT-IN: absent = off, only "true" is on. Shown to administrators and operators only (the roles the api copies).
 */
export function InvoiceCopyCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const prefs = usePreferences();
  const savePrefs = useSavePreferences();
  if (user?.role !== "TENANT_ADMIN" && user?.role !== "OPERATOR") return null;

  const on = prefs.data?.[PREF.invoiceEmailCopy] === "true";
  function onToggle() {
    savePrefs.mutate(
      { [PREF.invoiceEmailCopy]: on ? "false" : "true" },
      {
        onSuccess: () => toast({ variant: "success", title: "Your preference is saved" }),
        onError: () => toast({ variant: "error", title: "Couldn't save your preference" }),
      },
    );
  }

  return (
    <Card id="invoice-copies" title="Copies of emails you send">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-navy">Send me a copy of invoices I email</div>
          <div className="text-xs text-navy/70">
            When you email an invoice to a customer, we also send a copy to you
            {user?.email ? ` at ${user.email}` : ""}. The customer does not see it.
          </div>
        </div>
        <MiniSwitch
          checked={on}
          disabled={savePrefs.isPending || prefs.isLoading}
          ariaLabel="Send me a copy of invoices I email"
          onToggle={onToggle}
        />
      </div>
    </Card>
  );
}
