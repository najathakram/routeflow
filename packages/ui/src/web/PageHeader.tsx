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
      className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}
      {...props}
    >
      <div className="shrink">
        <h1 className="text-2xl font-bold text-navy whitespace-nowrap">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-navy/60">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  ),
);

PageHeader.displayName = "PageHeader";
