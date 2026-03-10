import * as React from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "./utils";

export interface StatCardProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  value: string | number;
  icon?: React.ReactNode;
  trend?: number;
  trendLabel?: string;
}

export const StatCard = React.forwardRef<HTMLDivElement, StatCardProps>(
  ({ className, label, value, icon, trend, trendLabel, ...props }, ref) => {
    const isPositive = trend !== undefined && trend > 0;
    const isNeutral  = trend === 0;

    return (
      <div
        ref={ref}
        className={cn("rounded-lg bg-white p-6 shadow-card", className)}
        {...props}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-navy/60 truncate">{label}</p>
            <p className="mt-1 text-2xl font-bold text-navy">{value}</p>
            {trend !== undefined && (
              <div
                className={cn(
                  "mt-2 inline-flex items-center gap-1 text-xs font-medium",
                  isPositive ? "text-success" : isNeutral ? "text-navy/40" : "text-danger",
                )}
              >
                {isPositive ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : isNeutral ? (
                  <Minus className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                <span>
                  {isPositive ? "+" : ""}
                  {trend}%{trendLabel ? ` ${trendLabel}` : ""}
                </span>
              </div>
            )}
          </div>
          {icon && (
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-100 text-brand-500">
              {icon}
            </div>
          )}
        </div>
      </div>
    );
  },
);

StatCard.displayName = "StatCard";
