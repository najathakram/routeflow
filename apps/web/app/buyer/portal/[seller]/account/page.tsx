"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { User, Building2, ArrowLeft, Mail, KeyRound } from "lucide-react";
import { Badge, Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { clearActiveSeller } from "@/lib/buyer-auth";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getLinkStatusVariant(status: string): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "PENDING":
    case "PENDING_SELLER_APPROVAL":
      return "warning";
    case "SUSPENDED":
    case "DISCONNECTED":
      return "danger";
    default:
      return "neutral";
  }
}

function formatLinkStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerAccountPage() {
  const params = useParams();
  const router = useRouter();
  const { buyer, activeSeller, isLoading: authLoading } = useBuyerAuth();
  const sellerSlug = params.seller as string;

  // Validate slug matches active seller
  React.useEffect(() => {
    if (!authLoading && activeSeller && activeSeller.tenant.slug !== sellerSlug) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, sellerSlug, router]);

  // Redirect if no active seller after auth loads
  React.useEffect(() => {
    if (!authLoading && !activeSeller) {
      router.push("/buyer/portal");
    }
  }, [authLoading, activeSeller, router]);

  const handleSwitchSeller = () => {
    clearActiveSeller();
    router.push("/buyer/portal");
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-buyer-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy">Account</h1>
        {activeSeller?.customer && (
          <p className="text-sm text-navy/70 mt-1">
            {activeSeller.customer.businessName} at {activeSeller.tenant.name}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {/* Buyer profile card */}
        <div className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-buyer-50 text-buyer-600">
              <User className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-navy">Your Profile</h2>
          </div>

          <dl className="divide-y divide-surface-border">
            <div className="flex items-center justify-between py-3">
              <dt className="flex items-center gap-2 text-sm text-navy/70">
                <User className="h-4 w-4" />
                Full Name
              </dt>
              <dd className="text-sm font-medium text-navy">{buyer?.name ?? "N/A"}</dd>
            </div>
            <div className="flex items-center justify-between py-3">
              <dt className="flex items-center gap-2 text-sm text-navy/70">
                <Mail className="h-4 w-4" />
                Email
              </dt>
              <dd className="text-sm font-medium text-navy">{buyer?.email ?? "N/A"}</dd>
            </div>
          </dl>
        </div>

        {/* Current seller connection card */}
        {activeSeller && (
          <div className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised text-navy/70">
                <Building2 className="h-5 w-5" />
              </div>
              <h2 className="text-base font-semibold text-navy">Seller Connection</h2>
            </div>

            <dl className="divide-y divide-surface-border">
              <div className="flex items-center justify-between py-3">
                <dt className="text-sm text-navy/70">Seller</dt>
                <dd className="text-sm font-medium text-navy">{activeSeller.tenant.name}</dd>
              </div>
              <div className="flex items-center justify-between py-3">
                <dt className="text-sm text-navy/70">Your Business</dt>
                <dd className="text-sm font-medium text-navy">
                  {activeSeller.customer?.businessName ?? "N/A"}
                </dd>
              </div>
              {activeSeller.customer?.email && (
                <div className="flex items-center justify-between py-3">
                  <dt className="text-sm text-navy/70">Business Email</dt>
                  <dd className="text-sm font-medium text-navy">{activeSeller.customer.email}</dd>
                </div>
              )}
              <div className="flex items-center justify-between py-3">
                <dt className="text-sm text-navy/70">Connection Status</dt>
                <dd>
                  <Badge variant={getLinkStatusVariant(activeSeller.linkStatus)}>
                    {formatLinkStatus(activeSeller.linkStatus)}
                  </Badge>
                </dd>
              </div>
            </dl>

            <div className="mt-4 pt-4 border-t border-surface-border">
              <Button variant="secondary" size="sm" onClick={handleSwitchSeller}>
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Switch Seller
              </Button>
            </div>
          </div>
        )}

        {/* Security card */}
        <div className="rounded-xl border border-surface-border bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised text-navy/70">
              <KeyRound className="h-5 w-5" />
            </div>
            <h2 className="text-base font-semibold text-navy">Security</h2>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-navy">Password</p>
              <p className="text-xs text-navy/70 mt-0.5">Change your buyer portal password</p>
            </div>
            <a
              href="/buyer/change-password"
              className="flex items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-medium text-navy hover:bg-surface-raised transition-colors"
            >
              Change Password
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
