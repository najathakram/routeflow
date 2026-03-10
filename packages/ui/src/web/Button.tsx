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
          "text-brand-500 underline-offset-4 hover:underline focus-visible:ring-brand-500",
      },
      size: {
        sm: "h-8 px-3 text-sm rounded-sm",
        md: "h-10 px-4 text-sm rounded",
        lg: "h-12 px-6 text-base rounded-lg",
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
