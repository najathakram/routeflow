"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Building2, ArrowRight, RefreshCw, CheckCircle, X, Plus, Link2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Badge, Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import { requestSellerConnection, getBuyerAccessToken } from "@/lib/buyer-auth";
import type { BuyerSeller } from "@/lib/buyer-auth";

// ─── Status badge variant helper ─────────────────────────────────────────────

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

// ─── Seller Card ──────────────────────────────────────────────────────────────

function SellerCard({ seller, onClick }: { seller: BuyerSeller; onClick: () => void }) {
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-4 rounded-xl border border-surface-border bg-white p-4 text-left shadow-sm transition-all hover:border-buyer-300 hover:shadow-md"
    >
      {/* Logo */}
      <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl border border-surface-border bg-surface-raised overflow-hidden">
        {seller.tenant.logoKey ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${apiUrl}/uploads/${seller.tenant.logoKey}`}
            alt={seller.tenant.name}
            className="h-full w-full object-contain"
          />
        ) : (
          <Building2 className="h-6 w-6 text-navy/30" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-base font-semibold text-navy truncate">{seller.tenant.name}</p>
        <p className="text-sm text-navy/70 truncate">{seller.customer.businessName}</p>
        <div className="mt-1">
          <Badge variant={getLinkStatusVariant(seller.linkStatus)}>
            {formatLinkStatus(seller.linkStatus)}
          </Badge>
        </div>
      </div>

      {/* Arrow */}
      <ArrowRight className="h-5 w-5 flex-shrink-0 text-navy/30 transition-transform group-hover:translate-x-1 group-hover:text-buyer-500" />
    </button>
  );
}

// ─── Connect Seller Modal ─────────────────────────────────────────────────────

const connectSchema = z.object({
  sellerSlug: z
    .string()
    .min(1, "Seller company code is required")
    .transform((v) => v.trim().toLowerCase()),
  emailAtSeller: z
    .string()
    .min(1, "Your email at this seller is required")
    .email("Please enter a valid email address"),
});

type ConnectFormValues = z.infer<typeof connectSchema>;

function ConnectSellerModal({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<ConnectFormValues>({
    resolver: zodResolver(connectSchema),
  });

  // Reset state when modal closes
  React.useEffect(() => {
    if (!open) {
      reset();
      setApiError(null);
      setSubmitted(false);
    }
  }, [open, reset]);

  const onSubmit = async (data: ConnectFormValues) => {
    setApiError(null);
    const accessToken = getBuyerAccessToken();
    if (!accessToken) {
      setApiError("You are not logged in. Please sign in again.");
      return;
    }
    try {
      await requestSellerConnection(data.sellerSlug, data.emailAtSeller, accessToken);
      setSubmitted(true);
      onSuccess();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Could not send connection request. Please check the seller code and try again.";
      setApiError(typeof msg === "string" ? msg : "Request failed.");
    }
  };

  if (!open) return null;

  return (
    // Overlay
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white shadow-modal">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-buyer-100">
              <Link2 className="h-4 w-4 text-buyer-600" />
            </div>
            <h2 className="text-base font-semibold text-navy">Connect to a Seller</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">
          {submitted ? (
            <div className="flex flex-col items-center gap-4 py-4 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
                <CheckCircle className="h-6 w-6 text-success" />
              </div>
              <div>
                <p className="font-semibold text-navy">Request sent!</p>
                <p className="mt-1 text-sm text-navy/70">
                  Your seller will review and approve your connection. You&apos;ll see them in your
                  seller list once approved.
                </p>
              </div>
              <Button onClick={onClose} variant="secondary" className="w-full mt-2">
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5" noValidate>
              {apiError && (
                <div className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                  {apiError}
                </div>
              )}

              {/* Seller code field */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-navy">
                  Seller Company Code <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. acme-foods"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 transition-colors focus:outline-none focus:ring-2 focus:ring-buyer-500 focus:border-transparent"
                  {...register("sellerSlug")}
                />
                {errors.sellerSlug && (
                  <p className="text-xs text-danger">{errors.sellerSlug.message}</p>
                )}
                <p className="text-xs text-navy/70">
                  Ask your seller for their company code. You&apos;ll usually find it on your
                  invoices, emails, or their website.
                </p>
              </div>

              {/* Email at seller field */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-navy">
                  Your Email at This Seller <span className="text-danger">*</span>
                </label>
                <input
                  type="email"
                  placeholder="The email your seller knows you by"
                  autoComplete="email"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 transition-colors focus:outline-none focus:ring-2 focus:ring-buyer-500 focus:border-transparent"
                  {...register("emailAtSeller")}
                />
                {errors.emailAtSeller && (
                  <p className="text-xs text-danger">{errors.emailAtSeller.message}</p>
                )}
                <p className="text-xs text-navy/70">
                  This is the email address your seller has on file for you. It may differ from your
                  RouteFlow login email.
                </p>
              </div>

              {/* Footer */}
              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={onClose}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={isSubmitting} className="flex-1">
                  Send Request
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Linked success banner ────────────────────────────────────────────────────

function LinkedBanner({ sellerName }: { sellerName?: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (params.get("linked") === "true") {
      setVisible(true);
      const t = setTimeout(() => {
        setVisible(false);
        router.replace("/buyer/portal", { scroll: false });
      }, 5000);
      return () => clearTimeout(t);
    }
  }, [params, router]);

  if (!visible) return null;

  return (
    <div
      role="status"
      className="mb-5 flex items-start gap-3 rounded-xl border border-success/30 bg-success/10 px-4 py-3"
    >
      <CheckCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-success" />
      <p className="flex-1 text-sm font-medium text-success">
        {sellerName
          ? `You are now connected to ${sellerName}. Welcome!`
          : "Seller connected successfully. Welcome!"}
      </p>
      <button
        type="button"
        onClick={() => {
          setVisible(false);
          router.replace("/buyer/portal", { scroll: false });
        }}
        className="flex-shrink-0 text-success/60 hover:text-success transition-colors"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function BuyerPortalInner() {
  const router = useRouter();
  const { sellers, setActiveSeller, refreshSellers, isLoading } = useBuyerAuth();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [connectModalOpen, setConnectModalOpen] = React.useState(false);

  // Find the most recently linked active seller for the banner greeting
  const newestActiveSeller = React.useMemo(
    () => sellers.find((s) => s.linkStatus === "ACTIVE") ?? null,
    [sellers],
  );

  const handleSellerClick = (seller: BuyerSeller) => {
    setActiveSeller(seller);
    router.push(`/buyer/portal/${seller.tenant.slug}/orders`);
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshSellers();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleConnectSuccess = async () => {
    // Refresh the sellers list so the pending request shows up
    await refreshSellers().catch(() => {});
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Connect Seller Modal */}
      <ConnectSellerModal
        open={connectModalOpen}
        onClose={() => setConnectModalOpen(false)}
        onSuccess={handleConnectSuccess}
      />

      {/* Linked success banner */}
      <React.Suspense fallback={null}>
        <LinkedBanner sellerName={newestActiveSeller?.tenant.name} />
      </React.Suspense>

      {/* Page header */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-navy">Your Sellers</h1>
          <p className="text-sm text-navy/70 mt-1">
            Select a seller to view your orders and invoices.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="secondary" size="sm" onClick={handleRefresh} loading={isRefreshing}>
            <RefreshCw className="h-4 w-4 mr-1.5" />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setConnectModalOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" />
            Connect Seller
          </Button>
        </div>
      </div>

      {/* Sellers list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-buyer-500 border-t-transparent" />
        </div>
      ) : sellers.length === 0 ? (
        /* ── Empty state with clear CTAs ── */
        <div className="rounded-2xl border border-dashed border-surface-border bg-white p-10 text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-buyer-50">
            <Building2 className="h-8 w-8 text-buyer-400" />
          </div>
          <h2 className="text-lg font-semibold text-navy mb-2">No sellers connected yet</h2>
          <p className="text-sm text-navy/70 max-w-xs mx-auto mb-6">
            Connect with your seller to view your orders, invoices, and delivery updates. All in one
            place.
          </p>

          {/* Primary CTA */}
          <Button
            className="w-full max-w-xs mx-auto flex items-center justify-center gap-2"
            onClick={() => setConnectModalOpen(true)}
          >
            <Link2 className="h-4 w-4" />
            Connect to a Seller
          </Button>

          {/* Secondary hint */}
          <div className="mt-5 rounded-lg bg-surface-raised px-4 py-3 max-w-xs mx-auto">
            <p className="text-xs text-navy/70 text-left leading-relaxed">
              <span className="font-medium text-navy">Got an invite link?</span> Check your email
              from your seller and click the link. You&apos;ll be connected instantly.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sellers.map((seller) => (
            <SellerCard
              key={seller.linkId}
              seller={seller}
              onClick={() => handleSellerClick(seller)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Suspense wrapper required because LinkedBanner uses useSearchParams()
export default function BuyerPortalPage() {
  return (
    <React.Suspense fallback={null}>
      <BuyerPortalInner />
    </React.Suspense>
  );
}
