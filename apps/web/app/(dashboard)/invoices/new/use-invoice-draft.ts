"use client";

import * as React from "react";
import {
  INVOICE_DRAFT_DEBOUNCE_MS,
  clearInvoiceDraft,
  isPristineSnapshot,
  readInvoiceDraft,
  sanitizeSnapshot,
  writeInvoiceDraft,
  type StoredInvoiceDraft,
} from "@/lib/invoice-draft-storage";

/**
 * ROW 447: keeps the new-invoice form in localStorage (debounced) and surfaces a stored draft as an OFFER.
 *
 * - `key` null (no tenant or no user) = the hook does nothing.
 * - While an offer is open nothing is written, so typing into a fresh form cannot overwrite the draft being offered.
 * - `clear()` (a save went through) removes the entry and stops writing for the rest of this page's life: the invoice
 *   now exists on the server, and a later write would offer a duplicate on the next visit.
 * - A pending write is flushed on pagehide so a quick refresh does not lose the last keystrokes.
 */
export function useInvoiceDraft(key: string | null, form: unknown | null) {
  const [loadedKey, setLoadedKey] = React.useState<string | null>(null);
  const [offer, setOffer] = React.useState<StoredInvoiceDraft | null>(null);
  const closedRef = React.useRef(false);
  const formRef = React.useRef(form);
  formRef.current = form;

  React.useEffect(() => {
    setOffer(key ? readInvoiceDraft(key) : null);
    setLoadedKey(key);
  }, [key]);

  const writable = !!key && loadedKey === key && !offer;

  React.useEffect(() => {
    if (!writable || !form || closedRef.current) return;
    const t = setTimeout(() => {
      if (closedRef.current) return;
      const snap = sanitizeSnapshot(form);
      // Everything emptied out again: the old entry would restore something the user removed.
      if (snap && isPristineSnapshot(snap)) clearInvoiceDraft(key);
      else writeInvoiceDraft(key, form);
    }, INVOICE_DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [writable, form, key]);

  React.useEffect(() => {
    if (!writable) return;
    const flush = () => {
      if (!closedRef.current && formRef.current) writeInvoiceDraft(key, formRef.current);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [writable, key]);

  return {
    /** The stored draft being offered, or null. */
    offer,
    /** The offer was applied (or answered): writes resume. */
    resolveOffer: React.useCallback(() => setOffer(null), []),
    /** Discard: remove the entry and close the offer. */
    discard: React.useCallback(() => {
      clearInvoiceDraft(key);
      setOffer(null);
    }, [key]),
    /** A save succeeded: remove the entry and stop writing. */
    clear: React.useCallback(() => {
      closedRef.current = true;
      clearInvoiceDraft(key);
      setOffer(null);
    }, [key]),
  };
}
