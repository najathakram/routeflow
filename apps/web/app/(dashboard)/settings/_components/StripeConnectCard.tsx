"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { CreditCard, CheckCircle2, AlertCircle, AlertTriangle, Trash2 } from "lucide-react";
import { Card, Badge, Button, useToast, cn } from "@routeflow/ui/web";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useAuth } from "@/lib/auth-context";
import {
  useStripeConnectStatus,
  useStartStripeConnect,
  useDisconnectStripe,
} from "@/lib/api/stripe-connect";

const maskAccount = (id: string) => (id.length > 8 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id);

function extractErrorMessage(err: unknown): string | undefined {
  return (
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
    (err as { message?: string })?.message
  );
}

/**
 * Tenant Settings "Payments" card — link the tenant's OWN Stripe account (Connect
 * Standard, direct charges, no platform fee) so buyer card payments settle straight
 * into it. Renders one of five states depending on platform config + connection
 * status, plus an inline banner when the browser just returned from the Stripe OAuth
 * flow (?stripe=connected&charges=... | ?stripe=error&reason=...).
 */
export function StripeConnectCard() {
  const { toast } = useToast();
  const { user } = useAuth();
  // The status route is @Roles(OPERATOR), but CUSTOMER/DRIVER users may open /settings —
  // don't fire a request that only ever 403s for them, and don't render the card at all.
  const canManage =
    user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN" || user?.role === "SUPER_ADMIN";
  const { data, isLoading, isError } = useStripeConnectStatus({ enabled: canManage });
  const startConnect = useStartStripeConnect();
  const disconnect = useDisconnectStripe();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const params = useSearchParams();
  const flag = params.get("stripe");
  const reason = params.get("reason");
  // `connected` here means the OAuth leg returned — charges may still be pending.
  const banner =
    flag === "connected"
      ? {
          tone: "success" as const,
          text:
            params.get("charges") === "enabled"
              ? "Stripe connected — you can now accept card payments."
              : "Stripe connected. Finish your details in Stripe before cards work.",
        }
      : flag === "error"
        ? { tone: "error" as const, text: reason ?? "Could not connect Stripe." }
        : null;

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        setConfirmOpen(false);
        toast({ title: "Stripe disconnected", variant: "success" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Couldn't disconnect Stripe",
          description: extractErrorMessage(err),
          variant: "error",
        }),
    });
  };

  if (!canManage || isLoading) return null;

  const configured = data?.configured ?? false;
  const connected = data?.connected ?? false;
  const chargesEnabled = data?.chargesEnabled ?? false;
  const testMode = connected && data?.livemode === false;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <CreditCard className="h-5 w-5 text-brand-600" />
        <h3 className="text-base font-semibold text-navy">Card payments (Stripe)</h3>
        {connected && chargesEnabled && <Badge variant="success" label="Active" />}
        {connected && !chargesEnabled && <Badge variant="warning" label="Finishing setup" />}
        {testMode && <Badge variant="neutral" label="Test mode" />}
      </div>

      {banner && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-ctl px-3 py-2 text-sm",
            banner.tone === "success" ? "bg-success-bg text-success" : "bg-danger-bg text-danger",
          )}
        >
          {banner.tone === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none" />
          ) : (
            <AlertCircle className="mt-0.5 h-4 w-4 flex-none" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      {/* The status fetch failed — a load error must not read as "the platform
          doesn't do cards", which is what the not-configured copy below would say. */}
      {isError && (
        <p className="text-sm text-navy/50">Couldn&apos;t load Stripe status. Try again shortly.</p>
      )}

      {/* Not configured on the platform — nothing a tenant can do here yet. */}
      {!isError && !configured && (
        <p className="text-sm text-navy/50">
          Card payments aren&apos;t enabled on this platform yet.
        </p>
      )}

      {/* Configured, not yet connected — offer to link. */}
      {configured && !connected && (
        <>
          <p className="text-sm text-navy/70">
            Connect your own Stripe account so customers can pay their invoices by card. Payments go
            straight into your Stripe account — RouteFlow takes no fee.
          </p>
          <div>
            <Button onClick={() => startConnect.mutate()} loading={startConnect.isPending}>
              Connect Stripe
            </Button>
          </div>
        </>
      )}

      {/* Connected — account details + disconnect, with the charges-pending case
          getting an extra explainer. */}
      {connected && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-navy/70">
            Connected account{" "}
            <span className="font-mono font-medium text-navy">
              {data?.stripeAccountId ? maskAccount(data.stripeAccountId) : "—"}
            </span>
            {data?.connectedAt && (
              <>
                {" "}
                · connected{" "}
                {new Date(data.connectedAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </>
            )}
          </p>

          {!chargesEnabled && (
            <div className="flex items-start gap-2 rounded-ctl bg-warning-bg px-3 py-2 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>
                Stripe still needs a few more details from you before cards can be accepted.
              </span>
            </div>
          )}

          <div>
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(true)}
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              Disconnect
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleDisconnect}
        title="Disconnect Stripe?"
        description="Customers won't be able to pay by card until you reconnect. Cash payment declarations are unaffected."
        confirmLabel="Disconnect"
        variant="danger"
        loading={disconnect.isPending}
      />
    </Card>
  );
}
