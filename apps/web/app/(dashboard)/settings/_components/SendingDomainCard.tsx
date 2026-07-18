"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { Card, Button, Input, Badge, useToast } from "@routeflow/ui/web";
import { CheckCircle2, Copy, RefreshCw, Trash2, Globe, AlertTriangle } from "lucide-react";

type DomainRecord = {
  record: string;
  type: string;
  name: string;
  value: string;
  priority?: number;
  status?: string;
};

type DomainStatus = {
  platformConfigured: boolean;
  domain: string | null;
  status: "none" | "pending" | "verified" | "failed";
  records: DomainRecord[];
  fromAddress: string | null;
};

type Action =
  | { type: "add"; domain: string }
  | { type: "verify" }
  | { type: "refresh" }
  | { type: "from"; address: string }
  | { type: "remove" };

const KEY = ["settings", "email-domain"] as const;

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded-ctl border border-surface-border px-2 py-1 text-xs text-navy/70 transition-colors hover:border-brand-400 hover:text-brand-600"
      aria-label="Copy value"
    >
      {copied ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * Per-tenant sending-domain verification (Resend). Lets a business send invoices from
 * its OWN domain with proper SPF/DKIM: add the domain → the app registers it with Resend
 * and shows the DNS records → add them to DNS → verify → pick a From address. Until a
 * domain is verified, email sends from the platform address with the business name +
 * reply-to (handled server-side), so this whole card is optional.
 */
export function SendingDomainCard() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<DomainStatus>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/settings/email/domain").then((r) => r.data),
  });
  const [domainInput, setDomainInput] = React.useState("");
  const [fromInput, setFromInput] = React.useState("");

  React.useEffect(() => {
    if (data?.fromAddress) setFromInput(data.fromAddress);
    else if (data?.status === "verified" && data.domain && !fromInput) {
      setFromInput(`invoices@${data.domain}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.fromAddress, data?.status, data?.domain]);

  const action = useMutation({
    mutationFn: (a: Action) => {
      switch (a.type) {
        case "add":
          return apiClient.post("/settings/email/domain", { domain: a.domain }).then((r) => r.data);
        case "verify":
          return apiClient.post("/settings/email/domain/verify").then((r) => r.data);
        case "refresh":
          return apiClient.post("/settings/email/domain/refresh").then((r) => r.data);
        case "from":
          return apiClient
            .post("/settings/email/domain/from", { address: a.address })
            .then((r) => r.data);
        case "remove":
          return apiClient.delete("/settings/email/domain").then((r) => r.data);
      }
    },
    onSuccess: (d: DomainStatus, vars) => {
      qc.setQueryData(KEY, d);
      if (vars.type === "verify")
        toast({
          title: d.status === "verified" ? "Domain verified" : "Not verified yet",
          description:
            d.status === "verified"
              ? "You can now send from your own domain."
              : "DNS can take a while to propagate — try again in a few minutes.",
          variant: d.status === "verified" ? "success" : "warning",
        });
      if (vars.type === "from") toast({ title: "From address saved", variant: "success" });
      if (vars.type === "add") setDomainInput("");
    },
    onError: (e: any) =>
      toast({
        title: "Couldn't update the domain",
        description: e?.response?.data?.message || e.message,
        variant: "error",
      }),
  });

  if (isLoading) return null;
  const status = data?.status ?? "none";
  const domain = data?.domain ?? null;

  const statusBadge =
    status === "verified" ? (
      <Badge variant="success">Verified</Badge>
    ) : status === "failed" ? (
      <Badge variant="danger">Not verified</Badge>
    ) : status === "pending" ? (
      <Badge variant="warning">Pending DNS</Badge>
    ) : null;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Globe className="h-5 w-5 text-brand-600" />
        <h3 className="text-base font-semibold text-navy">Send from your own domain</h3>
        {statusBadge}
      </div>

      {/* How email sends right now */}
      {status === "verified" && data?.fromAddress ? (
        <p className="text-sm text-navy/70">
          Emails send from <span className="font-medium text-navy">{data.fromAddress}</span>.
          Replies go to your business email.
        </p>
      ) : data?.platformConfigured ? (
        <p className="text-sm text-navy/70">
          Emails currently send from your business name via RouteFlow, with replies routed to your
          email. Verify your own domain below to send from your own address for better branding and
          deliverability.
        </p>
      ) : (
        <div className="flex items-start gap-2 rounded-ctl bg-warning-bg px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          <span>
            Platform email isn’t set up yet — an admin needs to add the email service key before
            domains can be verified. Your own SMTP setup above works independently of this.
          </span>
        </div>
      )}

      {/* Step 1 — add a domain */}
      {status === "none" && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            placeholder="mail.yourbusiness.com"
            className="flex-1"
            aria-label="Sending domain"
          />
          <Button
            onClick={() => action.mutate({ type: "add", domain: domainInput })}
            disabled={!domainInput.trim() || action.isPending || !data?.platformConfigured}
          >
            Add domain
          </Button>
        </div>
      )}

      {/* Step 2 — DNS records to add (pending / failed) */}
      {domain && (status === "pending" || status === "failed") && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-navy/70">
            Add these DNS records to <span className="font-medium text-navy">{domain}</span> at your
            DNS provider, then verify. They can take a few minutes to a few hours to propagate.
          </p>
          <div className="overflow-x-auto rounded-card border border-surface-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-secondary/50 text-navy/60">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Name / Host</th>
                  <th className="px-3 py-2 font-medium">Value</th>
                  <th className="px-3 py-2 font-medium">Priority</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {(data?.records ?? []).map((r, i) => (
                  <tr key={i} className="border-t border-surface-border align-top">
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-navy">{r.type}</td>
                    <td className="max-w-[160px] break-all px-3 py-2 font-mono text-navy/80">
                      {r.name}
                    </td>
                    <td className="max-w-[280px] break-all px-3 py-2 font-mono text-navy/80">
                      {r.value}
                    </td>
                    <td className="px-3 py-2 text-navy/70">{r.priority ?? "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <CopyBtn value={r.value} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {status === "failed" && (
            <p className="text-sm text-danger">
              The last check couldn’t find the records. Double-check they match exactly (no trailing
              dots or quotes your DNS provider adds automatically), then verify again.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => action.mutate({ type: "verify" })}
              disabled={action.isPending}
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
            >
              {action.isPending ? "Checking…" : "Verify"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => action.mutate({ type: "refresh" })}
              disabled={action.isPending}
              leftIcon={<RefreshCw className="h-4 w-4" />}
            >
              Refresh status
            </Button>
            <Button
              variant="ghost"
              onClick={() => action.mutate({ type: "remove" })}
              disabled={action.isPending}
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              Remove
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — pick a from-address (verified) */}
      {status === "verified" && (
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-navy">From address</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              placeholder={`invoices@${domain}`}
              className="flex-1"
              aria-label="From address"
            />
            <Button
              onClick={() => action.mutate({ type: "from", address: fromInput })}
              disabled={!fromInput.trim() || action.isPending}
            >
              Use this address
            </Button>
          </div>
          <p className="text-xs text-navy/50">
            Any address on {domain} works (it doesn’t need a real inbox). Customer replies still go
            to your business email.
          </p>
          <div>
            <Button
              variant="ghost"
              onClick={() => action.mutate({ type: "remove" })}
              disabled={action.isPending}
              leftIcon={<Trash2 className="h-4 w-4" />}
            >
              Remove domain
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
