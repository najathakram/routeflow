"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { Card, Button, Badge, useToast } from "@routeflow/ui/web";
import { Mail, Trash2, AlertTriangle } from "lucide-react";
import { useHasAddon } from "@/lib/api/tobacco";

/** email.connected_mailbox — registered `dark` in addon-gate-registry.ts (feature-registry.ts). */
export const EMAIL_CONNECTED_MAILBOX_ADDON = "email.connected_mailbox";

type MailboxStatus = {
  configured: boolean;
  googleConfigured: boolean;
  microsoftConfigured: boolean;
  connected: boolean;
  provider?: "GOOGLE" | "MICROSOFT";
  accountEmail?: string;
  status?: "CONNECTED" | "REVOKED" | "THROTTLED";
  throttledUntil?: string | null;
  lastError?: string | null;
  lastSentAt?: string | null;
};

const KEY = ["settings", "email-mailbox"] as const;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * "Connect Gmail" / "Connect Outlook" card (email-connect-google PR-2/PR-3,
 * email-connect-microsoft PR-4). Send tenant-branded mail through the tenant's own Google or
 * Microsoft mailbox (Gmail API `gmail.send` / Graph `Mail.Send` — never a read scope) instead
 * of RouteFlow's relay — falls back automatically to the tenant's own SMTP, then "<Business> via
 * RouteFlow", whenever the mailbox is disconnected, revoked, or rate-limited. One connection per
 * tenant, either provider (reconnecting with the other provider replaces it). Hidden entirely
 * unless the `email.connected_mailbox` add-on is granted (dark rollout) — independent of
 * `googleConfigured`/`microsoftConfigured`, which each require that provider's mailbox OAuth
 * client env vars to be set (the buttons render independently per provider, design §4).
 */
export function MailboxCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const hasAddon = useHasAddon(EMAIL_CONNECTED_MAILBOX_ADDON);
  // Guards against React re-running the confirm effect twice (StrictMode double-invoke, a
  // re-render before the URL is cleaned up) — the confirm token is single-use server-side
  // anyway, but this avoids a spurious second "couldn't confirm" toast.
  const confirmedRef = React.useRef(false);

  const { data, isLoading } = useQuery<MailboxStatus>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/settings/email/mailbox").then((r) => r.data),
    enabled: hasAddon,
  });

  // Which provider was connected before a disconnect — the DELETE response doesn't echo it
  // back, and by onSuccess time the query cache has already been overwritten.
  const disconnectingProviderRef = React.useRef<"GOOGLE" | "MICROSOFT" | undefined>(undefined);

  const disconnect = useMutation({
    mutationFn: () => {
      disconnectingProviderRef.current = data?.provider;
      return apiClient.delete("/settings/email/mailbox").then((r) => r.data);
    },
    onSuccess: (d: { deleted: boolean; message?: string }) => {
      const wasMicrosoft = disconnectingProviderRef.current === "MICROSOFT";
      const label = wasMicrosoft ? "Outlook" : "Gmail";
      if (d?.deleted) {
        qc.setQueryData(KEY, {
          configured: data?.configured ?? true,
          googleConfigured: data?.googleConfigured ?? true,
          microsoftConfigured: data?.microsoftConfigured ?? true,
          connected: false,
        });
        // Microsoft has no app-side revoke — `message` carries the "remove RouteFlow from your
        // Microsoft account" instruction even though `deleted` is true; Google's `message` only
        // appears on a FAILED disconnect (handled below), so this branch is a no-op for Google.
        toast({
          title: `${label} mailbox disconnected`,
          description: wasMicrosoft ? d.message : undefined,
          variant: "success",
        });
      } else {
        // Revoke-at-Google failed — the row is kept (marked REVOKED) so a retry can pick it
        // back up; refetch so the card reflects that instead of assuming success.
        qc.invalidateQueries({ queryKey: KEY });
        toast({
          title: "Couldn't fully disconnect",
          description: d?.message,
          variant: "warning",
        });
      }
    },
    onError: (e: any) =>
      toast({
        title: "Couldn't disconnect",
        description: e?.response?.data?.message || e.message,
        variant: "error",
      }),
  });

  const connect = useMutation({
    mutationFn: (provider: "GOOGLE" | "MICROSOFT") =>
      apiClient
        .get(
          provider === "MICROSOFT"
            ? "/settings/email/mailbox/microsoft/start"
            : "/settings/email/mailbox/google/start",
        )
        .then((r) => r.data),
    onSuccess: (d: { url?: string }) => {
      if (d?.url) window.location.href = d.url;
    },
    onError: (e: any, provider) =>
      toast({
        title: `Couldn't start ${provider === "MICROSOFT" ? "Microsoft" : "Google"} connect`,
        description: e?.response?.data?.message || e.message,
        variant: "error",
      }),
  });

  // Confirm-on-return step (security review fix round, HIGH): the OAuth callback never binds
  // the connection itself — it redirects here with a one-time `mailbox_confirm` token that
  // this authenticated tab must POST back to /confirm before anything is actually connected.
  const confirm = useMutation({
    mutationFn: (state: string) =>
      apiClient.post("/settings/email/mailbox/confirm", { state }).then((r) => r.data),
    onSuccess: (d: MailboxStatus) => {
      qc.setQueryData(KEY, d);
      toast({
        title: `${d.provider === "MICROSOFT" ? "Outlook" : "Gmail"} mailbox connected`,
        variant: "success",
      });
    },
    onError: (e: any) =>
      toast({
        title: "Couldn't finish connecting the mailbox",
        description:
          e?.response?.status === 403
            ? "That connect attempt didn't match your account — try connecting again."
            : e?.response?.data?.message || e.message,
        variant: "error",
      }),
  });

  React.useEffect(() => {
    if (confirmedRef.current) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const confirmToken = params.get("mailbox_confirm");
    const hadError = params.get("mailbox_error");
    // Risk-based step-up consent (design §1) — the tenant's Microsoft org blocked user consent
    // for an unverified multitenant app; only an org admin can grant it.
    const adminConsentRequired = params.get("mailbox_admin_consent_required");
    if (!confirmToken && !hadError && !adminConsentRequired) return;

    confirmedRef.current = true;
    params.delete("mailbox_confirm");
    params.delete("mailbox_error");
    params.delete("mailbox_admin_consent_required");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);

    if (confirmToken) confirm.mutate(confirmToken);
    else if (adminConsentRequired) {
      toast({
        title: "Your organisation requires admin approval",
        description:
          "An admin needs to approve RouteFlow for your Microsoft organisation before you can " +
          "connect Outlook — ask a Microsoft 365 admin to grant consent, then try again.",
        variant: "error",
      });
    } else if (hadError) {
      toast({
        title: "Couldn't connect the mailbox",
        description: "The provider didn't complete the connection — try again.",
        variant: "error",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!hasAddon || isLoading) return null;
  if (!data?.configured) return null; // Neither provider's mailbox client env vars are set yet.

  const status = data.status ?? null;
  const isMicrosoft = data.provider === "MICROSOFT";
  const providerLabel = isMicrosoft ? "Outlook" : "Gmail";
  const vendorLabel = isMicrosoft ? "Microsoft" : "Google";

  const statusBadge =
    status === "CONNECTED" ? (
      <Badge variant="success">Connected</Badge>
    ) : status === "THROTTLED" ? (
      <Badge variant="warning">Rate-limited</Badge>
    ) : status === "REVOKED" ? (
      <Badge variant="danger">Reconnect needed</Badge>
    ) : null;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Mail className="h-5 w-5 text-brand-600" />
        <h3 className="text-base font-semibold text-navy">
          {data.connected ? `Connect ${providerLabel}` : "Connect your email"}
        </h3>
        {statusBadge}
      </div>

      {!data.connected && (
        <>
          <p className="text-sm text-navy/70">
            Send customer emails directly from your own Gmail or Outlook account instead of
            RouteFlow&apos;s relay — replies and bounces land in your own inbox. Falls back
            automatically to your SMTP setup above (or RouteFlow&apos;s) if the connection ever
            needs attention.
          </p>
          <div className="flex flex-wrap gap-2">
            {data.googleConfigured && (
              <Button onClick={() => connect.mutate("GOOGLE")} disabled={connect.isPending}>
                {connect.isPending ? "Redirecting…" : "Connect Gmail"}
              </Button>
            )}
            {data.microsoftConfigured && (
              <Button
                variant="secondary"
                onClick={() => connect.mutate("MICROSOFT")}
                disabled={connect.isPending}
              >
                {connect.isPending ? "Redirecting…" : "Connect Outlook"}
              </Button>
            )}
          </div>
        </>
      )}

      {data.connected && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-navy/70">
            Sending as <span className="font-medium text-navy">{data.accountEmail}</span>.
          </p>

          {status === "THROTTLED" && (
            <div className="flex items-start gap-2 rounded-ctl bg-warning-bg px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>
                Rate-limited by {vendorLabel}
                {data.throttledUntil ? ` until ${formatDate(data.throttledUntil)}` : ""} — falling
                back to your SMTP setup (or RouteFlow&apos;s) until then.
              </span>
            </div>
          )}

          {status === "REVOKED" && (
            <div className="flex items-start gap-2 rounded-ctl bg-danger-bg px-3 py-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>
                {vendorLabel} revoked access to this mailbox — reconnect below. Mail is falling
                back to your SMTP setup (or RouteFlow&apos;s) until then.
              </span>
            </div>
          )}

          {data.lastError && status !== "THROTTLED" && status !== "REVOKED" && (
            <p className="text-xs text-navy/50">Last error: {data.lastError}</p>
          )}

          <p className="text-xs text-navy/50">
            Bounces and replies arrive in your own {providerLabel} inbox — RouteFlow can&apos;t
            read them (only {isMicrosoft ? "`Mail.Send`" : "`gmail.send`"} is granted, never a
            read scope).
          </p>

          <div className="flex flex-wrap gap-2">
            {status === "REVOKED" && (
              <Button
                onClick={() => connect.mutate(isMicrosoft ? "MICROSOFT" : "GOOGLE")}
                disabled={connect.isPending}
              >
                {connect.isPending ? "Redirecting…" : "Reconnect"}
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
