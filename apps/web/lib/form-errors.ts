"use client";

import { useCallback } from "react";
import { useToast } from "@routeflow/ui/web";

type ToastFn = (opts: { title: string; variant: "error" }) => unknown;

/** A react-hook-form leaf error carries a `type` (and usually a `message`); a branch does not. */
function isLeaf(v: object): boolean {
  const o = v as Record<string, unknown>;
  return typeof o.type === "string" || typeof o.message === "string";
}

/** How many fields are invalid in an RHF `errors` object (nested objects and arrays included). */
export function countFieldErrors(errors: unknown): number {
  if (!errors || typeof errors !== "object") return 0;
  if (Array.isArray(errors)) return errors.reduce((n, e) => n + countFieldErrors(e), 0);
  if (isLeaf(errors)) return 1;
  return Object.values(errors as Record<string, unknown>).reduce<number>(
    (n, e) => n + countFieldErrors(e),
    0,
  );
}

export function fixFieldsTitle(n: number): string {
  return n === 1 ? "Fix 1 field" : `Fix ${n} fields`;
}

/**
 * `handleSubmit(onSubmit, onInvalid)` handler: toast "Fix N field(s)" and move the user to the
 * first `[aria-invalid="true"]` control. Runs after a tick so the error state has rendered.
 */
export function onInvalidFocus(errors: unknown, toast: ToastFn): void {
  const n = countFieldErrors(errors);
  if (n === 0) return;
  toast({ title: fixFieldsTitle(n), variant: "error" });
  // The aria-invalid attributes land with the next render: wait a frame, retry once if absent.
  const focusFirst = (retry: boolean) => {
    const el = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!el) {
      if (retry) requestAnimationFrame(() => focusFirst(false));
      return;
    }
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  };
  requestAnimationFrame(() => focusFirst(true));
}

/** Hook form of {@link onInvalidFocus}: `handleSubmit(onSubmit, useInvalidFocus())`. */
export function useInvalidFocus(): (errors: unknown) => void {
  const { toast } = useToast();
  return useCallback((errors: unknown) => onInvalidFocus(errors, toast as ToastFn), [toast]);
}
