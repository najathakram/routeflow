import * as React from "react";

/** The slice of the created customer the register needs. */
export interface CreatedCustomer {
  id: string;
  businessName: string;
}

/**
 * Row 240: "New customer" at the counter opens the EXISTING customer form (validation and all), started from the typed search
 * as the business name. The form hands the created customer back through `onCreated`; closing it any other way hands back
 * nothing, and the buyer stays unanswered.
 */
export function useCounterNewCustomer(onCreated: (customer: CreatedCustomer) => void) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  return {
    open,
    prefillName: name,
    onCreated,
    openWith: (typed: string) => {
      setName(typed.trim());
      setOpen(true);
    },
    close: () => setOpen(false),
  };
}
