"use client";

import * as React from "react";
import { CustomerFormModal } from "../../customers/_components/CustomerFormModal";

/**
 * W-1041: the one "new customer" door both order screens share. `open(name)` shows the customer window over the sale with
 * the typed search in it; a save hands the new customer to `onPicked` and the window closes. The window is drawn only
 * while open, so a screen that never opens it mounts nothing. `addressRequired` is false for a sale that needs no address.
 *
 * SA-1066 F21: the window has no Radix trigger, so closing it without a save (Escape, X, Cancel) left focus on <body>. Pass
 * `focusBack` (where focus goes when the opener is gone, e.g. the Find a customer box) to turn on the return: focus goes to
 * the element that opened it, `open`'s `opener` or else whatever held focus (a click that focuses nothing, Safari, has none),
 * and a save never takes part, since the screen's own pick has already refocused where the next scan goes.
 */
export function useNewCustomerDoor<C extends { id: string; businessName: string }>(
  onPicked: (customer: C) => void,
  addressRequired = false,
  focusBack?: () => HTMLElement | null,
) {
  const [typed, setTyped] = React.useState<string | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const savedRef = React.useRef(false);
  const dismissedRef = React.useRef(false);
  const focusBackRef = React.useRef(focusBack);
  focusBackRef.current = focusBack;
  const open = React.useCallback((name = "", opener?: HTMLElement | null) => {
    const held = document.activeElement;
    openerRef.current =
      opener instanceof HTMLElement
        ? opener
        : held instanceof HTMLElement && held !== document.body
          ? held
          : null;
    savedRef.current = false;
    dismissedRef.current = false;
    setTyped(name);
  }, []);
  // After the window is gone, and after Radix has put focus wherever it puts it (its own restore runs on a 0 ms timer).
  React.useEffect(() => {
    if (typed !== null || !dismissedRef.current) return;
    dismissedRef.current = false;
    const t = setTimeout(() => {
      const o = openerRef.current;
      const gone = !o || !o.isConnected || (o as HTMLButtonElement).disabled;
      (gone ? focusBackRef.current?.() : o)?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [typed]);
  const modal =
    typed === null ? null : (
      <CustomerFormModal
        isOpen
        mode="add"
        initialName={typed}
        addressRequired={addressRequired}
        onCreated={(c) => {
          savedRef.current = true;
          onPicked(c as unknown as C);
        }}
        onClose={() => {
          dismissedRef.current = !!focusBackRef.current && !savedRef.current;
          setTyped(null);
        }}
      />
    );
  return { open, modal };
}
