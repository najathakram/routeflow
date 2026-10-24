"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { Card, Button, Badge, Modal, useToast } from "@routeflow/ui/web";
import { Mail, Trash2, AlertTriangle } from "lucide-react";
import {
  API_ERROR_CODES,
  type MailboxConnectionStatus,
  type MailboxProvider,
} from "@routeflow/types";
import { useHasAddon } from "@/lib/api/tobacco";

/** email.connected_mailbox — registered `dark` in addon-gate-registry.ts (feature-registry.ts). */
export const EMAIL_CONNECTED_MAILBOX_ADDON = "email.connected_mailbox";

/**
 * The one-time connect secret `/start` hands the tab that starts a connect (#2115, SA-215). Only
 * this tab's sessionStorage holds it (the server keeps a hash), and preview/confirm require it, so
 * a `mailbox_confirm` link opened in any other tab or browser can't bind anything, even with the
 * same admin signed in. It travels in a request header, never in a URL.
 */
export const CONNECT_SECRET_STORAGE_KEY = "rf:mailbox:connect-secret";
const CONNECT_SECRET_HEADER = "X-Mailbox-Connect-Secret";

function readConnectSecret(): string | null {
  try {
    return window.sessionStorage.getItem(CONNECT_SECRET_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** False when this tab can't keep the secret (storage blocked): the connect must not start. */
function storeConnectSecret(secret: string): boolean {
  try {
    window.sessionStorage.setItem(CONNECT_SECRET_STORAGE_KEY, secret);
    return window.sessionStorage.getItem(CONNECT_SECRET_STORAGE_KEY) === secret;
  } catch {
    return false;
  }
}

function clearConnectSecret() {
  try {
    window.sessionStorage.removeItem(CONNECT_SECRET_STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

type MailboxStatus = {
  configured: boolean;
  googleConfigured: boolean;
  microsoftConfigured: boolean;
  connected: boolean;
  provider?: MailboxProvider;
  accountEmail?: string;
  status?: MailboxConnectionStatus;
  throttledUntil?: string | null;
  lastError?: string | null;
  lastSentAt?: string | null;
};

/** What the confirm dialog is told about a pending grant: which account, nothing else. */
type ConnectPreview = { provider: MailboxProvider; accountEmail: string };
type PendingConfirm = ConnectPreview & { token: string; secret: string };

const KEY = ["settings", "email-mailbox"] as const;

const mailboxLabel = (provider: MailboxProvider | undefined) =>
  provider === "MICROSOFT" ? "Outlook" : "Gmail";

/** Why a returning `mailbox_confirm` can't be confirmed here. Nothing was ever bound. */
const REFUSED_COPY = {
  "other-tab":
    "This connection can only be confirmed in the browser tab where it was started. Nothing " +
    "was connected. Connect again from this page.",
  "other-admin":
    "This connection was started by a different user or in a different workspace. Only the " +
    "admin who started it can confirm it. Nothing was connected.",
  "no-addon":
    "Connected mailboxes aren't enabled for this workspace, so nothing was connected. Contact " +
    "RouteFlow support to turn them on.",
  forbidden: "Your account can't connect a mailbox for this workspace. Nothing was connected.",
  expired:
    "This connection request expired or was already used. Nothing was connected. Connect again.",
  unavailable: "We couldn't check this connection request. Nothing was connected. Connect again.",
} as const;
type Refusal = keyof typeof REFUSED_COPY;

/**
 * The server's distinct 403 causes on preview/confirm, by the exact value each one sends: the
 * two grant-holder checks in `MailboxConnectionService.assertGrantHolder` (the `message` of a
 * bare ForbiddenException) and AddonGuard's `code`. Any other 403 (RolesGuard, no tenant context)
 * is a permission refusal, never the "other tab" one. The values come from `@routeflow/types`
 * (`API_ERROR_CODES`, pinned to the API's throw sites by api-error-codes-parity.spec.ts, #2163).
 */

function refusalOf(e: any): Refusal {
  const status = e?.response?.status;
  if (status === 400) return "expired";
  if (status !== 403) return "unavailable";
  const body = e?.response?.data;
  if (body?.message === API_ERROR_CODES.MAILBOX_CONNECT_SECRET_MISMATCH) return "other-tab";
  if (body?.message === API_ERROR_CODES.MAILBOX_CONFIRM_IDENTITY_MISMATCH) return "other-admin";
  if (body?.code === API_ERROR_CODES.ADDON_GATE) return "no-addon";
  return "forbidden";
}

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
 *
 * Connecting never binds anything on return from the provider (#2115): the card previews the
 * pending grant with this tab's connect secret and asks "Connect <account> to this workspace?".
 * Only Confirm binds it; Cancel, dismissing the dialog, or any refusal burns it.
 */
export function MailboxCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const hasAddon = useHasAddon(EMAIL_CONNECTED_MAILBOX_ADDON);
  // Guards against React re-running the return-flag effect twice (StrictMode double-invoke, a
  // re-render before the URL is cleaned up): the flags are handled exactly once per page load.
  const confirmedRef = React.useRef(false);
  const [pendingConfirm, setPendingConfirm] = React.useState<PendingConfirm | null>(null);
  // What the dialog shows. Set on open and never cleared, so its text stays put while the close
  // animation runs after `pendingConfirm` is cleared.
  const [dialogContent, setDialogContent] = React.useState<ConnectPreview | null>(null);

  const { data, isLoading } = useQuery<MailboxStatus>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/settings/email/mailbox").then((r) => r.data),
    enabled: hasAddon,
  });

  // Which provider was connected before a disconnect — the DELETE response doesn't echo it
  // back, and by onSuccess time the query cache has already been overwritten.
  const disconnectingProviderRef = React.useRef<MailboxProvider | undefined>(undefined);

  const disconnect = useMutation({
    mutationFn: () => {
      disconnectingProviderRef.current = data?.provider;
      return apiClient.delete("/settings/email/mailbox").then((r) => r.data);
    },
    onSuccess: async (d: { deleted: boolean; message?: string }) => {
      const wasMicrosoft = disconnectingProviderRef.current === "MICROSOFT";
      const label = wasMicrosoft ? "Outlook" : "Gmail";
      if (d?.deleted) {
        // A status GET still in flight (e.g. the refetch after an earlier failed disconnect)
        // read the row BEFORE this delete; left alone it would resolve after the write below and
        // put the deleted connection back on screen. TanStack Query never drops an in-flight
        // fetch's result on setQueryData, so cancel it first.
        await qc.cancelQueries({ queryKey: KEY });
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
    mutationFn: (provider: MailboxProvider) =>
      apiClient
        .get(
          provider === "MICROSOFT"
            ? "/settings/email/mailbox/microsoft/start"
            : "/settings/email/mailbox/google/start",
        )
        .then((r) => r.data),
    onSuccess: (d: { url?: string; connectSecret?: string }, provider) => {
      const title = `Couldn't start ${provider === "MICROSOFT" ? "Microsoft" : "Google"} connect`;
      if (!d?.url || !d.connectSecret) {
        toast({ title, description: "Something went wrong. Try again.", variant: "error" });
        return;
      }
      // The secret must be in this tab BEFORE it leaves for the provider: without it, the
      // grant that comes back can never be confirmed.
      if (!storeConnectSecret(d.connectSecret)) {
        toast({
          title,
          description:
            "This browser is blocking the site storage RouteFlow needs to finish connecting " +
            "securely. Allow site data for RouteFlow (or leave private browsing), then try again.",
          variant: "error",
        });
        return;
      }
      window.location.href = d.url;
    },
    onError: (e: any, provider) =>
      toast({
        title: `Couldn't start ${provider === "MICROSOFT" ? "Microsoft" : "Google"} connect`,
        description: e?.response?.data?.message || e.message,
        variant: "error",
      }),
  });

  /** Burn a pending grant nobody will confirm. Best effort: if this call fails, the grant still
   *  expires on its own within 10 minutes, and it stays bound to this tab's secret meanwhile. */
  function discardPendingGrant(token: string) {
    return apiClient
      .post("/settings/email/mailbox/confirm/cancel", { state: token })
      .catch(() => undefined);
  }

  function refuseConfirm(token: string, reason: Refusal) {
    clearConnectSecret();
    void discardPendingGrant(token);
    toast({ title: "Mailbox not connected", description: REFUSED_COPY[reason], variant: "error" });
  }

  // The return from the provider: preview the pending grant (non-consuming) with THIS tab's
  // connect secret, then ask. No secret here means the link was opened somewhere other than
  // the tab that started the connect, so it is refused without ever asking the server about it.
  async function openConfirm(token: string) {
    const secret = readConnectSecret();
    if (!secret) {
      refuseConfirm(token, "other-tab");
      return;
    }
    try {
      const { data: preview } = await apiClient.get<ConnectPreview>(
        `/settings/email/mailbox/confirm/${encodeURIComponent(token)}/preview`,
        { headers: { [CONNECT_SECRET_HEADER]: secret } },
      );
      const shown = { provider: preview.provider, accountEmail: preview.accountEmail };
      setDialogContent(shown);
      setPendingConfirm({ ...shown, token, secret });
    } catch (e: any) {
      refuseConfirm(token, refusalOf(e));
    }
  }

  // The ONLY place a connection is bound, and only on an explicit Confirm in the dialog.
  const confirm = useMutation({
    mutationFn: (p: PendingConfirm) =>
      apiClient
        .post(
          "/settings/email/mailbox/confirm",
          { state: p.token },
          { headers: { [CONNECT_SECRET_HEADER]: p.secret } },
        )
        .then((r) => r.data),
    onSuccess: async (d: MailboxStatus) => {
      // A status GET that was already in flight read the row before the confirm committed. If it
      // answered after the write below, it would put "not connected" back (TanStack Query never
      // drops an in-flight fetch's result on setQueryData), so cancel it first.
      await qc.cancelQueries({ queryKey: KEY });
      qc.setQueryData(KEY, d);
      toast({ title: `${mailboxLabel(d.provider)} mailbox connected`, variant: "success" });
    },
    onError: (e: any) => {
      const status = e?.response?.status;
      toast({
        title: "Couldn't finish connecting the mailbox",
        description:
          status === 403 || status === 400
            ? REFUSED_COPY[refusalOf(e)]
            : e?.response?.data?.message || e.message,
        variant: "error",
      });
    },
    // The grant is single-use server-side: whatever the outcome, it is spent now.
    onSettled: () => {
      clearConnectSecret();
      setPendingConfirm(null);
    },
  });

  function confirmPending() {
    if (pendingConfirm && !confirm.isPending) confirm.mutate(pendingConfirm);
  }

  // Cancel, Escape, the close button and a click outside all land here: the grant is burned.
  function cancelPending() {
    if (!pendingConfirm || confirm.isPending) return;
    const { token, provider } = pendingConfirm;
    setPendingConfirm(null);
    clearConnectSecret();
    void discardPendingGrant(token);
    toast({
      title: `${mailboxLabel(provider)} not connected`,
      description: "You cancelled. Nothing was changed.",
      variant: "info",
    });
  }

  React.useEffect(() => {
    if (confirmedRef.current) return;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const confirmToken = params.get("mailbox_confirm");
    const hadError = params.get("mailbox_error");
    // Risk-based step-up consent (design §1) — the tenant's Microsoft org blocked user consent
    // for an unverified multitenant app; only an org admin can grant it.
    const adminConsentRequired = params.get("mailbox_admin_consent_required");
    // The user backed out on the provider's own consent screen (the Google callback's
    // `error=access_denied`). The value names the provider. Nothing was bound: the callback
    // never writes a connection row (see mailbox.controller.ts).
    const cancelledProvider = params.get("mailbox_cancelled");
    if (!confirmToken && !hadError && !adminConsentRequired && !cancelledProvider) return;

    confirmedRef.current = true;
    params.delete("mailbox_confirm");
    params.delete("mailbox_error");
    params.delete("mailbox_admin_consent_required");
    params.delete("mailbox_cancelled");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);

    if (confirmToken) {
      void openConfirm(confirmToken);
      return;
    }
    // Any other return ends the connect this tab started: its secret has nothing left to bind.
    clearConnectSecret();
    if (adminConsentRequired) {
      toast({
        title: "Your organisation requires admin approval",
        description:
          "An admin needs to approve RouteFlow for your Microsoft organisation before you can " +
          "connect Outlook — ask a Microsoft 365 admin to grant consent, then try again.",
        variant: "error",
      });
    } else if (cancelledProvider) {
      // Not an error: the user chose to stop. Only Google sends this flag today; any other
      // value (a hand-edited URL) still gets a truthful, provider-neutral message.
      const what = cancelledProvider === "google" ? "Gmail" : "your mailbox";
      toast({
        title:
          cancelledProvider === "google" ? "Gmail connection cancelled" : "Connection cancelled",
        description: `You cancelled connecting ${what}; nothing was changed.`,
        variant: "info",
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

  // Rendered whether or not the card itself is showing: a returning admin must always get the
  // explicit choice, even while the card's own status is still loading.
  const confirmDialog = (
    <Modal
      open={pendingConfirm !== null}
      onClose={cancelPending}
      title={dialogContent ? `Connect ${dialogContent.accountEmail} to this workspace?` : undefined}
      description={
        `RouteFlow will send your customer emails, like invoices and reminders, from this ` +
        `${mailboxLabel(dialogContent?.provider)} account.`
      }
      className="break-words"
      footer={
        <>
          <Button variant="secondary" onClick={cancelPending} disabled={confirm.isPending}>
            Cancel
          </Button>
          <Button onClick={confirmPending} loading={confirm.isPending}>
            Confirm
          </Button>
        </>
      }
    >
      <p>
        Only confirm if you just signed in to this account yourself. If you don&apos;t recognise it,
        cancel and nothing will be connected.
      </p>
    </Modal>
  );

  // One tree shape whether or not the card itself shows, so the dialog always keeps its place:
  // the card finishing loading (or hiding) behind an open dialog never remounts that dialog.
  const withConfirmDialog = (card: React.ReactNode) => (
    <>
      {card}
      {confirmDialog}
    </>
  );

  if (!hasAddon || isLoading || !data?.configured) return withConfirmDialog(null);

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

  const card = (
    <Card className="flex flex-col gap-4" data-testid="mailbox-card">
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
                {vendorLabel} revoked access to this mailbox — reconnect below. Mail is falling back
                to your SMTP setup (or RouteFlow&apos;s) until then.
              </span>
            </div>
          )}

          {data.lastError && status !== "THROTTLED" && status !== "REVOKED" && (
            <p className="text-xs text-navy/50">
              The last sync reported a problem. Reconnect the mailbox if mail isn&apos;t sending.
            </p>
          )}

          <p className="text-xs text-navy/50">
            Bounces and replies arrive in your own {providerLabel} inbox — RouteFlow can&apos;t read
            them (only {isMicrosoft ? "`Mail.Send`" : "`gmail.send`"} is granted, never a read
            scope).
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

  return withConfirmDialog(card);
}
