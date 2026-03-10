import * as React from "react";
import { cn } from "./utils";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, title, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("rounded-lg bg-white p-6 shadow-card", className)}
      {...props}
    >
      {title && (
        <h3 className="mb-4 text-base font-semibold text-navy">{title}</h3>
      )}
      {children}
    </div>
  ),
);

Card.displayName = "Card";
