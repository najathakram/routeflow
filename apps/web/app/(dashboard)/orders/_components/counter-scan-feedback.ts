/**
 * F05: the words the scan / search box answers with. Composed here, in code, from the typed text and the product name
 * only: a server message never reaches the clerk (the B986 raw-message ratchet).
 */

/** How much of a rejected text the message echoes: a 13-digit barcode fits whole, a pasted wall does not. */
export const SCAN_ECHO_MAX = 24;

/** The rejected text as one short, printable line: control characters gone, runs of space folded, cut with an ellipsis. */
function echo(text: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length > SCAN_ECHO_MAX ? `${chars.slice(0, SCAN_ECHO_MAX).join("")}…` : flat;
}

/** A code that matched nothing: names the rejected text. */
export const noProductCopy = (text: string): string => `No product for '${echo(text)}'`;

/** A scan that landed on the cart. */
export const addedCopy = (productName: string): string => `Added ${productName.trim() || "item"}`;

/** How long the "Added …" confirmation stays before it fades (ms). */
export const ADDED_CONFIRMATION_MS = 2500;
