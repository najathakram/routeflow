import { API_ERROR_CODES } from "@routeflow/types";

/**
 * B743 (PR C): the mobile receive screen's prompt for the API's PACK_SIZE_UNKNOWN refusal. Pure,
 * so the exact wording, including the consequence line, is pinned by a unit test. It matches the
 * web dialog (PackSizeUnknownModal): a silent loose-pieces choice IS the B743 bug, so the prompt
 * always spells out what receiving as loose pieces does.
 */
/** One line the API's PACK_SIZE_UNKNOWN gate flagged (B743; mirrors pack-size-gate.ts). */
export interface PackSizeUnknownLine {
  id: string | null;
  lineIndex: number;
  description: string;
  productId: string;
  productName: string;
  qty: number;
  unitCost: number;
  /** The product's own known pack, for display only; 0 = none known. */
  productPack: number;
}
export interface PackSizeUnknownError {
  code: typeof API_ERROR_CODES.PACK_SIZE_UNKNOWN;
  message: string;
  packSizeUnknownItems: PackSizeUnknownLine[];
}

/** B743: extract the PACK_SIZE_UNKNOWN payload from an axios error, if that's what it is. */
export function getPackSizeUnknownError(error: unknown): PackSizeUnknownError | null {
  const data = (error as { response?: { data?: { code?: string } } })?.response?.data;
  return data?.code === API_ERROR_CODES.PACK_SIZE_UNKNOWN ? (data as PackSizeUnknownError) : null;
}

export const LOOSE_PIECES_CONSEQUENCE = "Stock counts each as 1 piece; cost is per piece.";

export function packSizeUnknownPrompt(err: PackSizeUnknownError): {
  title: string;
  message: string;
  confirmText: string;
} {
  const lines = err.packSizeUnknownItems;
  const shown = lines
    .slice(0, 5)
    .map((l) => {
      const pack = l.productPack > 1 ? ` (usually a case of ${l.productPack})` : "";
      return `• ${l.description || l.productName}${pack}`;
    })
    .join("\n");
  const more = lines.length > 5 ? `\n…and ${lines.length - 5} more` : "";
  return {
    title: "Units per case missing",
    message:
      `${err.message}\n\n${shown}${more}\n\n` +
      `Receiving as loose pieces: ${LOOSE_PIECES_CONSEQUENCE}\n` +
      "To fix the case sizes instead, cancel and set the case sizes on the bill's lines in the web dashboard.",
    confirmText: "Receive as loose pieces",
  };
}
