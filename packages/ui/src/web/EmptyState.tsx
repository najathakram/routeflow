import * as React from "react";
import { cn } from "./utils";
import {
  IllustrationNoOrders,
  IllustrationNoRoutes,
  IllustrationNoCustomers,
  IllustrationNoProducts,
  IllustrationNoInvoices,
  IllustrationNoDrivers,
  IllustrationNoReturns,
  IllustrationInboxZero,
  IllustrationNoData,
} from "./illustrations";

export type EmptyStateVariant =
  | "orders"
  | "routes"
  | "customers"
  | "products"
  | "invoices"
  | "drivers"
  | "returns"
  | "inbox"
  | "data"
  | "custom";

const ILLUSTRATION_MAP: Record<
  Exclude<EmptyStateVariant, "custom">,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  orders: IllustrationNoOrders,
  routes: IllustrationNoRoutes,
  customers: IllustrationNoCustomers,
  products: IllustrationNoProducts,
  invoices: IllustrationNoInvoices,
  drivers: IllustrationNoDrivers,
  returns: IllustrationNoReturns,
  inbox: IllustrationInboxZero,
  data: IllustrationNoData,
};

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  /** Custom icon/illustration node — used when variant="custom" */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  /** Illustration size in px (default 80) */
  size?: number;
}

/**
 * Consistent empty-state treatment for all list and detail pages.
 * Uses on-brand SVG illustrations keyed by content type.
 */
export function EmptyState({
  variant = "custom",
  icon,
  title,
  description,
  action,
  className,
  size = 80,
}: EmptyStateProps) {
  const IllustrationComp = variant !== "custom" ? ILLUSTRATION_MAP[variant] : null;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-4 py-16 px-8 text-center",
        className,
      )}
    >
      {IllustrationComp ? (
        <IllustrationComp size={size} />
      ) : icon ? (
        <div className="opacity-40">{icon}</div>
      ) : null}

      <div className="space-y-1.5 max-w-sm">
        <p className="text-base font-semibold text-navy">{title}</p>
        {description && <p className="text-sm text-navy/70 leading-relaxed">{description}</p>}
      </div>

      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
