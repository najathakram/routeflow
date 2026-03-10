"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 select-none whitespace-nowrap",
  {
    variants: {
      variant: {
        primary:
          "bg-brand-500 text-white hover:bg-brand-700 focus-visible:ring-brand-500",
        secondary:
          "bg-surface-raised text-navy border border-surface-border hover:bg-surface-border focus-visible:ring-navy",
        ghost:
          "text-navy hover:bg-surface-raised focus-visible:ring-navy",
        danger:
          "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger",
        link:
          "text-brand-500 underline-offset-4 hover:underline p-0 h-auto rounded-none",
      },
      size: {
        sm: "h-8 px-3 text-sm rounded-sm",
        md: "h-10 px-4 text-sm rounded",
        lg: "h-12 px-6 text-base rounded-lg",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">,
    VariantProps<typeof buttonVariants> {
  children?: React.ReactNode;
  href?: string;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      href,
      loading = false,
      disabled,
      leftIcon,
      rightIcon,
      children,
      onClick,
      ...props
    },
    ref,
  ) => {
    const classes = cn(buttonVariants({ variant, size }), className);

    if (href) {
      return (
        <a
          href={href}
          className={cn(classes, (disabled || loading) && "pointer-events-none opacity-50")}
          aria-disabled={disabled || loading}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : leftIcon}
          {children}
          {!loading && rightIcon}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        className={classes}
        disabled={disabled || loading}
        onClick={onClick}
        aria-busy={loading}
        {...props}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : leftIcon}
        {children}
        {!loading && rightIcon}
      </button>
    );
  },
);

Button.displayName = "Button";
