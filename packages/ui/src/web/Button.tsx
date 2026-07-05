"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "./utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 select-none whitespace-nowrap",
  {
    variants: {
      // Surface-aware: primary follows --accent, so buyer renders emerald and
      // admin indigo automatically (via .surface-buyer / .surface-admin).
      variant: {
        primary: "bg-accent-strong text-white hover:bg-accent-deep focus-visible:ring-accent",
        secondary:
          "bg-paper text-navy border border-line-strong shadow-card hover:bg-surface-raised focus-visible:ring-navy",
        ghost: "text-ink-500 hover:bg-sunken hover:text-navy focus-visible:ring-navy",
        danger: "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger",
        link: "text-accent-deep underline underline-offset-[3px] hover:no-underline focus-visible:ring-accent",
      },
      // Ledger control heights: sm 28 / md 34 / lg 40, 6px corners.
      size: {
        sm: "h-7 px-2.5 text-[12.5px] rounded-ctl",
        md: "h-[34px] px-3.5 text-[13px] rounded-ctl",
        lg: "h-10 px-[18px] text-sm rounded-ctl",
      },
    },
    // Override the height/padding/radius that size applies when variant=link,
    // so the button renders inline like a text link regardless of size prop.
    compoundVariants: [
      { variant: "link", size: "sm", class: "h-auto p-0 rounded-none" },
      { variant: "link", size: "md", class: "h-auto p-0 rounded-none" },
      { variant: "link", size: "lg", class: "h-auto p-0 rounded-none" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">,
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

    const isDisabled = disabled || loading;

    if (href) {
      return (
        <a
          href={href}
          className={cn(classes, isDisabled && "pointer-events-none opacity-50")}
          aria-disabled={isDisabled}
          tabIndex={isDisabled ? -1 : undefined}
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
        disabled={isDisabled}
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
