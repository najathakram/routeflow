import * as React from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import { cn } from "./utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  register?: Partial<UseFormRegisterReturn>;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, register, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-navy"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            "h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent",
            error && "border-danger focus:ring-danger",
            props.disabled && "opacity-50 cursor-not-allowed bg-surface-raised",
            className,
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...register}
          {...props}
        />
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";
