"use client";

import * as React from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import { cn, mergeRefs } from "./utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  register?: Partial<UseFormRegisterReturn>;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, register, id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-navy">
            {label}
          </label>
        )}
        <textarea
          id={inputId}
          className={cn(
            "w-full rounded border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/70 transition-colors resize-y min-h-[80px]",
            "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent",
            error && "border-danger focus:ring-danger",
            props.disabled && "opacity-50 cursor-not-allowed bg-surface-raised",
            className,
          )}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...register}
          {...props}
          ref={mergeRefs(ref, register?.ref)}
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

Textarea.displayName = "Textarea";
