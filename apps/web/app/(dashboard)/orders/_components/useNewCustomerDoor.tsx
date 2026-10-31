"use client";

import * as React from "react";
import { CustomerFormModal } from "../../customers/_components/CustomerFormModal";

/**
 * W-1041: the one "new customer" door both order screens share. `open(name)` shows the customer window over the sale with
 * the typed search in it; a save hands the new customer to `onPicked` and the window closes. The window is drawn only
 * while open, so a screen that never opens it mounts nothing. `addressRequired` is false for a sale that needs no address.
 */
export function useNewCustomerDoor<C extends { id: string; businessName: string }>(
  onPicked: (customer: C) => void,
  addressRequired = false,
) {
  const [typed, setTyped] = React.useState<string | null>(null);
  const open = React.useCallback((name = "") => setTyped(name), []);
  const modal =
    typed === null ? null : (
      <CustomerFormModal
        isOpen
        mode="add"
        initialName={typed}
        addressRequired={addressRequired}
        onCreated={(c) => onPicked(c as unknown as C)}
        onClose={() => setTyped(null)}
      />
    );
  return { open, modal };
}
