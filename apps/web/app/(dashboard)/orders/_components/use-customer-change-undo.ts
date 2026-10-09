import * as React from "react";

/** What picking a customer set, so Undo can put it all back (PKG-4 F11). */
export interface CustomerSnapshot<C, Cr> {
  customer: C;
  fulfillPath: string;
  credits: Cr[];
}

interface Args<C, Cr> {
  selectedCustomer: C | null;
  fulfillPath: string | undefined;
  appliedCredits: Cr[];
  setSelectedCustomer: (c: C | null) => void;
  setFulfillPath: (p: string) => void;
}

/**
 * The chip x ("Change customer") clears the customer but keeps the lines; this keeps the previous
 * customer + fulfilment path + applied credits so one Undo restores them, and moves focus to the
 * customer search after clearing (K7).
 *
 * Credits: the modal's customer-id effect clears `appliedCredits` on every customer swap, so the
 * restored set is handed to that effect through `takeRestoredCredits()` rather than set here.
 * The server re-validates credits at submit: a stale one is refused with CREDIT_NOTE_UNAVAILABLE
 * (B1204), never applied.
 */
export function useCustomerChangeUndo<C, Cr>({
  selectedCustomer,
  fulfillPath,
  appliedCredits,
  setSelectedCustomer,
  setFulfillPath,
}: Args<C, Cr>) {
  const [previous, setPrevious] = React.useState<CustomerSnapshot<C, Cr> | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const restoredCredits = React.useRef<Cr[] | null>(null);
  const focusSearch = React.useRef(false);
  // The chip's "Change customer" x: Undo removes its own chip, so focus goes back here instead of to <body>.
  const chipRef = React.useRef<HTMLButtonElement>(null);
  const focusChip = React.useRef(false);

  React.useEffect(() => {
    if (focusSearch.current && !selectedCustomer) {
      focusSearch.current = false;
      searchInputRef.current?.focus();
    }
    if (focusChip.current && selectedCustomer) {
      focusChip.current = false;
      chipRef.current?.focus();
    }
  }, [selectedCustomer]);

  // Stable identity: the modal's customer-id effect lists it as a dependency.
  const takeRestoredCredits = React.useCallback((): Cr[] => {
    const c = restoredCredits.current ?? [];
    restoredCredits.current = null;
    return c;
  }, []);

  const change = () => {
    if (!selectedCustomer) return;
    setPrevious({
      customer: selectedCustomer,
      fulfillPath: fulfillPath ?? "ROUTE",
      credits: appliedCredits,
    });
    focusSearch.current = true;
    setSelectedCustomer(null);
  };

  const undo = () => {
    if (!previous) return;
    restoredCredits.current = previous.credits;
    focusChip.current = true;
    setSelectedCustomer(previous.customer);
    setFulfillPath(previous.fulfillPath);
    setPrevious(null);
  };

  return {
    previous,
    change,
    undo,
    dismiss: () => setPrevious(null),
    searchInputRef,
    chipRef,
    /** Called by the customer-id effect: the credits to start from (Undo's, else none). */
    takeRestoredCredits,
  };
}
