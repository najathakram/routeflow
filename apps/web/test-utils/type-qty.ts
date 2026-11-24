import { fireEvent } from "@testing-library/react";

/** SA-1262: a till quantity box holds its text until Enter, Tab or blur; this types a value and leaves the box (the commit). */
export function typeQty(el: HTMLElement, value: string): void {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}
