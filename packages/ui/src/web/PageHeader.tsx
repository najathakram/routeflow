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
        {/* h2, not h1: the dashboard layout's top bar already renders the page
            <h1>, so the large visible page title is the second-level heading.
            Keeps one h1 per page and avoids a duplicate-h1 a11y violation. */}
        <h2 className="text-2xl font-bold text-navy whitespace-nowrap">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-navy/70">{subtitle}</p>}
      </div>
      {/* B749/B770: shrink-0 with no max-w-full meant this wrapper never actually shrank
          below the action content's own natural width, so a caller's own `flex-wrap` on
          that content never got a narrow-enough box to wrap INTO — the class was present
          but inert. max-w-full lets the wrapper (and this row) actually narrow at a small
          viewport, so wrap-enabled action content can wrap as its own classes intend. */}
      {action && <div className="max-w-full shrink-0">{action}</div>}
    </div>
  ),
);

PageHeader.displayName = "PageHeader";
