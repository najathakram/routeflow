import * as React from "react";
import { getStoredUser } from "@/lib/auth";

/**
 * A minimal "unsaved New product" draft in localStorage. The form's fields are plain strings (no
 * secrets, no files); every storage call is wrapped so a blocked, full or absent store is silent.
 */

export const DRAFT_VERSION = 1;
const KEY_BASE = "routeflow:product-create-draft:v1";
export const DRAFT_SAVE_DELAY_MS = 500;

/** The blank New product form; also the baseline "has the user typed anything" is measured against. */
export const EMPTY_DRAFT_FORM = {
  name: "",
  sku: "",
  barcode: "",
  unitSku: "",
  unit: "",
  pricePerUnit: "",
  category: "",
  description: "",
  costingMethod: "AVCO",
  standardCost: "",
  unitsPerBox: "",
  parentProductId: "",
  variantName: "",
  trackedCategoryId: "",
  trackedSubcategoryId: "",
  regItemType: "",
  regUomCase: "",
  regUomUnit: "",
};

export type DraftFields = typeof EMPTY_DRAFT_FORM;
const FIELD_KEYS = Object.keys(EMPTY_DRAFT_FORM) as (keyof DraftFields)[];

export interface ProductCreateDraft {
  savedAt: number;
  fields: DraftFields;
}

/**
 * The draft's storage key, scoped to tenant AND user id. With no signed-in user (no token, an expired
 * one, or an unreadable store) there is no key and drafts are OFF: no read, no write, no banner. There
 * is deliberately no shared fallback key, or one staff member's draft could be offered to another on
 * the same browser.
 */
export function draftKey(): string | null {
  try {
    const u = getStoredUser();
    if (u?.id) return `${KEY_BASE}:${u.tenantSlug ?? "-"}:${u.id}`;
  } catch {
    /* no account, no draft */
  }
  return null;
}

export function draftHasInput(fields: DraftFields): boolean {
  return FIELD_KEYS.some((k) => fields[k].trim() !== EMPTY_DRAFT_FORM[k]);
}

export function readDraft(key: string): ProductCreateDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: unknown; savedAt?: unknown; fields?: unknown };
    if (!parsed || parsed.v !== DRAFT_VERSION) return null;
    if (!parsed.fields || typeof parsed.fields !== "object") return null;
    const src = parsed.fields as Record<string, unknown>;
    const fields = { ...EMPTY_DRAFT_FORM };
    for (const k of FIELD_KEYS) {
      const v = src[k];
      if (v === undefined) continue;
      if (typeof v !== "string") return null;
      fields[k] = v;
    }
    if (!draftHasInput(fields)) return null;
    return { savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0, fields };
  } catch {
    return null;
  }
}

export function writeDraft(key: string, fields: DraftFields): void {
  try {
    const picked = {} as DraftFields;
    for (const k of FIELD_KEYS) picked[k] = fields[k];
    localStorage.setItem(
      key,
      JSON.stringify({ v: DRAFT_VERSION, savedAt: Date.now(), fields: picked }),
    );
  } catch {
    /* storage unavailable: the draft is a convenience, never a requirement */
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/**
 * Draft save + restore offer for the New product modal.
 *
 * - `enabled` is false for any prefilled or variant (family) use of the modal: only a plain New
 *   product keeps a draft.
 * - The offer is read synchronously (lazy initial state, and a layout effect when a kept-mounted
 *   modal re-opens) so the banner is in the first paint and never shifts content afterwards.
 * - While an offer is waiting for an answer nothing is saved, so the old draft is not overwritten.
 */
export function useProductCreateDraft({
  isOpen,
  enabled,
  form,
  onRestore,
}: {
  isOpen: boolean;
  enabled: boolean;
  form: DraftFields;
  onRestore: (fields: DraftFields) => void;
}) {
  const keyRef = React.useRef<string | null>(null);
  const [offer, setOffer] = React.useState<ProductCreateDraft | null>(() => {
    keyRef.current = draftKey();
    return isOpen && enabled && keyRef.current ? readDraft(keyRef.current) : null;
  });
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedThisOpen = React.useRef(false);
  const wasOpen = React.useRef(isOpen);

  const cancelTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  // A modal kept mounted and re-opened: decide again (for whoever is signed in now) before that paint.
  React.useLayoutEffect(() => {
    if (isOpen && !wasOpen.current) {
      keyRef.current = draftKey();
      savedThisOpen.current = false;
      setOffer(enabled && keyRef.current ? readDraft(keyRef.current) : null);
    }
    if (!isOpen) {
      cancelTimer();
      setOffer(null);
    }
    wasOpen.current = isOpen;
  }, [isOpen, enabled]);

  // Debounced save while the form has user input. No account (no key) means no draft at all.
  React.useEffect(() => {
    const key = keyRef.current;
    if (!isOpen || !enabled || !key || offer) return;
    if (!draftHasInput(form)) {
      // The user typed, then emptied the form: nothing left worth restoring.
      if (savedThisOpen.current) {
        savedThisOpen.current = false;
        clearDraft(key);
      }
      return;
    }
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      savedThisOpen.current = true;
      writeDraft(key, form);
    }, DRAFT_SAVE_DELAY_MS);
    return cancelTimer;
  }, [form, isOpen, enabled, offer]);

  const clear = React.useCallback(() => {
    cancelTimer();
    savedThisOpen.current = false;
    if (keyRef.current) clearDraft(keyRef.current);
    setOffer(null);
  }, []);

  const restore = () => {
    if (!offer) return;
    onRestore(offer.fields);
    setOffer(null);
  };

  return { offer, restore, discard: clear, clear };
}
