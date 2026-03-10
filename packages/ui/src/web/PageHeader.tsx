import * as React from "react";
import { cn } from "./utils";

export interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}

export const PageHeader = React.forwardRef<HTMLDivElement, PageHeaderProps>(
  ({ className, title, subtitle, action, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-start justify-between gap-4", className)}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-navy truncate">{title}</h1>
        {subtitle && (
          <p className="mt-1 text-sm text-navy/60">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  ),
);

PageHeader.displayName = "PageHeader";
