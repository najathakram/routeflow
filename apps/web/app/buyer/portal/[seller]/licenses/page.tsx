"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { ShieldCheck, ShieldAlert, Clock, CheckCircle2, XCircle } from "lucide-react";
import { Badge, Button, useToast } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { fmtCalendarDate } from "@/lib/formatting";
import {
  useBuyerAuthorizations,
  useSubmitBuyerAuthorization,
  type BuyerAuthorizationRow,
} from "@/lib/api/buyer";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type AuthStatus = BuyerAuthorizationRow["status"];

function statusBadge(status: AuthStatus): {
  variant: "success" | "warning" | "danger" | "neutral";
  label: string;
} {
  switch (status) {
    case "VERIFIED":
      return { variant: "success", label: "Verified" };
    case "PENDING_REVIEW":
      return { variant: "warning", label: "Pending review" };
    case "EXPIRED":
      return { variant: "danger", label: "Expired" };
    case "REJECTED":
      return { variant: "danger", label: "Rejected" };
    case "NONE":
    default:
      return { variant: "neutral", label: "Not submitted" };
  }
}

function statusIcon(status: AuthStatus) {
  switch (status) {
    case "VERIFIED":
      return <CheckCircle2 className="h-5 w-5 text-success" />;
    case "PENDING_REVIEW":
      return <Clock className="h-5 w-5 text-warning" />;
    case "REJECTED":
    case "EXPIRED":
      return <XCircle className="h-5 w-5 text-danger" />;
    default:
      return <ShieldAlert className="h-5 w-5 text-navy/40" />;
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// The buyer submit endpoint only blocks a currently-valid VERIFIED license.
const canSubmit = (status: AuthStatus) => status !== "VERIFIED";

function ctaLabel(status: AuthStatus): string {
  switch (status) {
    case "PENDING_REVIEW":
      return "Update submission";
    case "EXPIRED":
    case "REJECTED":
      return "Resubmit license";
    default:
      return "Submit license";
  }
}

// ─── Submit form (inline, per category) ─────────────────────────────────────────

function LicenseForm({
  row,
  onDone,
  onCancel,
}: {
  row: BuyerAuthorizationRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const submit = useSubmitBuyerAuthorization();
  const { toast } = useToast();
  const [licenseNumber, setLicenseNumber] = React.useState(row.licenseNumber ?? "");
  const [expiresAt, setExpiresAt] = React.useState(row.expiresAt ? row.expiresAt.slice(0, 10) : "");
  const [consent, setConsent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!licenseNumber.trim()) return setError("Enter your license number.");
    if (!expiresAt) return setError("Enter the license expiry date.");
    if (new Date(expiresAt) < new Date(todayIso()))
      return setError("The expiry date is in the past.");
    if (!consent) return setError("You must consent to share this license with the seller.");

    submit.mutate(
      {
        trackedCategoryId: row.trackedCategoryId,
        licenseNumber: licenseNumber.trim(),
        expiresAt: new Date(expiresAt).toISOString(),
        shareConsent: consent,
      },
      {
        onSuccess: () => {
          toast({
            title: "License submitted",
            description: `${row.categoryName} license sent for review.`,
            variant: "success",
          });
          onDone();
        },
        onError: (err: unknown) => {
          const msg =
            (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
            "Could not submit your license. Please try again.";
          setError(Array.isArray(msg) ? msg.join(", ") : msg);
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-3 border-t border-surface-border pt-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-navy/70">License number</label>
        <input
          type="text"
          value={licenseNumber}
          onChange={(e) => setLicenseNumber(e.target.value)}
          placeholder="e.g. TOB-0099123"
          className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-navy/70">Expiry date</label>
        <input
          type="date"
          value={expiresAt}
          min={todayIso()}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
        />
      </div>
      <label className="flex items-start gap-2 text-xs text-navy/70">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-buyer-500"
        />
        <span>
          I confirm this license is accurate and consent to sharing it with this seller for
          verification.
        </span>
      </label>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" loading={submit.isPending}>
          Submit for review
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Category card ──────────────────────────────────────────────────────────────

function LicenseCard({
  row,
  open,
  onOpen,
  onClose,
}: {
  row: BuyerAuthorizationRow;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const badge = statusBadge(row.status);
  return (
    <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">{statusIcon(row.status)}</div>
          <div>
            <h2 className="text-base font-semibold text-navy">{row.categoryName}</h2>
            <div className="mt-1 flex items-center gap-2">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {row.status === "VERIFIED" && row.expiresAt && (
                <span className="text-xs text-navy/60">
                  Expires {fmtCalendarDate(row.expiresAt)}
                </span>
              )}
            </div>
            {row.licenseNumber && (
              <p className="mt-1.5 text-xs text-navy/60">License #{row.licenseNumber}</p>
            )}
            {row.status === "PENDING_REVIEW" && (
              <p className="mt-1.5 text-xs text-warning">Awaiting the seller&rsquo;s review.</p>
            )}
            {row.status === "REJECTED" && (
              <p className="mt-1.5 text-xs text-danger">
                The seller rejected this license. Please resubmit an updated one.
              </p>
            )}
          </div>
        </div>
        {canSubmit(row.status) && !open && (
          <Button
            size="sm"
            variant={row.status === "NONE" ? "primary" : "secondary"}
            onClick={onOpen}
          >
            {ctaLabel(row.status)}
          </Button>
        )}
      </div>
      {open && <LicenseForm row={row} onDone={onClose} onCancel={onClose} />}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerLicensesPage() {
  const params = useParams();
  const router = useRouter();
  const { activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  React.useEffect(() => {
    if (!authLoading && !activeSeller) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, router]);

  const { data: rows, isLoading, isError } = useBuyerAuthorizations();
  const [openId, setOpenId] = React.useState<string | null>(null);

  if (authLoading || isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-buyer-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl p-6">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-buyer-600" />
          <h1 className="text-2xl font-bold text-navy">Licenses &amp; Authorizations</h1>
        </div>
        {activeSeller && (
          <p className="mt-1 text-sm text-navy/70">
            Submit your licenses to unlock regulated products from {activeSeller.tenant.name}. Each
            seller verifies your licenses independently.
          </p>
        )}
      </div>

      {isError ? (
        <div className="rounded-xl border border-danger/30 bg-danger-bg/40 p-6 text-sm text-danger">
          Couldn&rsquo;t load your licenses. Please refresh the page.
        </div>
      ) : !rows || rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-8 text-center">
          <ShieldCheck className="mx-auto mb-2 h-8 w-8 text-navy/30" />
          <p className="text-sm font-medium text-navy">No licenses required</p>
          <p className="mt-1 text-xs text-navy/60">
            {activeSeller?.tenant.name ?? "This seller"} doesn&rsquo;t sell any license-gated
            products, so there&rsquo;s nothing to submit here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <LicenseCard
              key={row.trackedCategoryId}
              row={row}
              open={openId === row.trackedCategoryId}
              onOpen={() => setOpenId(row.trackedCategoryId)}
              onClose={() => setOpenId(null)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
