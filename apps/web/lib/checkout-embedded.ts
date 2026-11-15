import { useSyncExternalStore } from "react";
import type { CheckoutStart } from "@routeflow/types";

/**
 * SA-1139 R4/R5/R7: the one place the web decides between Stripe's hosted page and the embedded form.
 * The open secret lives in a tiny store so any mutation (billing page, payment-due banner) can show the
 * one panel mounted in the dashboard shell. The secret is held in memory only, never stored or logged,
 * and it is dropped on Back and on completion so a stale one is never reused.
 */

/**
 * Where each flow returns on completion: the same address its hosted twin uses, so the billing page's existing
 * handling runs unchanged. A card add must never land on a payment path (it would read "Payment received").
 */
export const CHECKOUT_RETURN_PATHS = {
  plan: "/settings/billing?checkout=success",
  pay: "/settings/billing?paid=1",
  cardAdd: "/settings/billing?paid=1&card=1",
} as const;

export type EmbeddedCheckoutOpen = { clientSecret: string; returnPath: string };

let current: EmbeddedCheckoutOpen | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getEmbeddedCheckout(): EmbeddedCheckoutOpen | null {
  return current;
}

export function getEmbeddedCheckoutSecret(): string | null {
  return current?.clientSecret ?? null;
}

export function getEmbeddedCheckoutReturnPath(): string | null {
  return current?.returnPath ?? null;
}

/** Each caller passes its own return path; there is no shared default. */
export function openEmbeddedCheckout(clientSecret: string, returnPath: string): void {
  current = { clientSecret, returnPath };
  emit();
}

export function closeEmbeddedCheckout(): void {
  if (current === null) return;
  current = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useEmbeddedCheckout(): EmbeddedCheckoutOpen | null {
  return useSyncExternalStore(subscribe, getEmbeddedCheckout, () => null);
}

/** The publishable key, baked at web build time. Empty when it was not set. */
export function stripePublishableKey(): string {
  return (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "").trim();
}

/**
 * Runs inside a mutationFn so a failure takes the caller's normal error path: an embedded answer with no
 * publishable key logs once and throws, and nothing opens. Hosted answers pass through untouched.
 */
export function assertCheckoutStartable(start: CheckoutStart): CheckoutStart {
  if (start.uiMode === "embedded" && !stripePublishableKey()) {
    // eslint-disable-next-line no-console -- the one deliberate log when the build has no key (R7)
    console.error("Embedded checkout needs NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY at web build time.");
    throw new Error("EMBEDDED_CHECKOUT_KEY_MISSING");
  }
  return start;
}

/**
 * Follows a started checkout: embedded opens the panel in place; hosted hands the url to `leave`
 * (today's redirect, behind each caller's own guards). `returnPath` is where an embedded completion goes.
 */
export function followCheckout(
  start: CheckoutStart,
  leave: (url: string) => void,
  returnPath: string,
): void {
  if (start.uiMode === "embedded") {
    openEmbeddedCheckout(start.clientSecret, returnPath);
    return;
  }
  leave(start.checkoutUrl);
}
