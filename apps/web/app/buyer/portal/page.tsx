"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Building2, ArrowRight, RefreshCw } from "lucide-react";
import { Badge, Button } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import type { BuyerSeller } from "@/lib/buyer-auth";

// ─── Status badge variant helper ─────────────────────────────────────────────

function getLinkStatusVariant(
  status: string,
): "success" | "warning" | "danger" | "neutral" {
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

function SellerCard({
  seller,
  onClick,
}: {
  seller: BuyerSeller;
  onClick: () => void;
}) {
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-4 rounded-xl border border-surface-border bg-white p-4 text-left shadow-sm transition-all hover:border-brand-300 hover:shadow-md"
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
        <p className="text-sm text-navy/60 truncate">{seller.customer.businessName}</p>
        <div className="mt-1">
          <Badge variant={getLinkStatusVariant(seller.linkStatus)}>
            {formatLinkStatus(seller.linkStatus)}
          </Badge>
        </div>
      </div>

      {/* Arrow */}
      <ArrowRight className="h-5 w-5 flex-shrink-0 text-navy/30 transition-transform group-hover:translate-x-1 group-hover:text-brand-500" />
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function BuyerPortalPage() {
  const router = useRouter();
  const { sellers, setActiveSeller, refreshSellers, isLoading } = useBuyerAuth();
  const [isRefreshing, setIsRefreshing] = React.useState(false);

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

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Page header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy">Your Sellers</h1>
          <p className="text-sm text-navy/60 mt-1">
            Select a seller to view your orders and invoices.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleRefresh}
          loading={isRefreshing}
        >
          <RefreshCw className="h-4 w-4 mr-1.5" />
          Refresh
        </Button>
      </div>

      {/* Sellers list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        </div>
      ) : sellers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-white p-12 text-center">
          <Building2 className="mx-auto mb-4 h-12 w-12 text-navy/20" />
          <h2 className="text-lg font-semibold text-navy mb-2">No sellers linked yet</h2>
          <p className="text-sm text-navy/60 max-w-sm mx-auto">
            You haven&apos;t been connected to any sellers yet. Ask your supplier to send you an
            invite link, or check your email for an invitation.
          </p>
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
