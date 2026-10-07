/**
 * B1220 — what a screen does with a `resolveProductByCode` result.
 *
 * A lone fuzzy match (`suggestion`) is never committed on its own: the screen asks
 * "Did you mean <name>?" and only commits on confirm. Cancel leaves everything unchanged.
 * Stock-writing screens (counts, receiving, adjustments) say "Apply"; the rest say "Add".
 */
import type { BarcodeResolveResult } from "./barcode-resolve";

/** Shape of `confirm` from `./confirm` — injected so this module stays pure (no react-native). */
export type ConfirmFn = (
  title: string,
  message: string,
  onConfirm: () => void,
  options?: { confirmText?: string; destructive?: boolean },
) => void;

export type ScanScreenKind = "add" | "stock";

export type ScanDecision<T = any> =
  | { kind: "add"; product: T }
  | {
      kind: "confirm-suggestion";
      product: T;
      title: string;
      message: string;
      confirmText: "Add" | "Apply";
    }
  | { kind: "pick-from-list"; matches: T[] }
  | { kind: "archived"; product: T }
  | { kind: "not-found" };

export function decideScanResult<T = any>(
  result: BarcodeResolveResult<T>,
  screen: ScanScreenKind = "add",
): ScanDecision<T> {
  if (result.notFound || !result.product) return { kind: "not-found" };
  if (result.archived) return { kind: "archived", product: result.product };
  if (result.ambiguous && result.suggestion) {
    const name = (result.product as { name?: string | null })?.name || "this item";
    return {
      kind: "confirm-suggestion",
      product: result.product,
      title: "Did you mean…",
      message: `Did you mean ${name}?`,
      confirmText: screen === "stock" ? "Apply" : "Add",
    };
  }
  if (result.ambiguous) return { kind: "pick-from-list", matches: result.matches ?? [] };
  return { kind: "add", product: result.product };
}

/**
 * Commit now for a plain add; for a suggestion, only after the user confirms via `confirmFn`
 * (pass `confirm` from `./confirm`).
 * Returns true when the decision was handled here (add or suggestion prompt).
 */
export function runScanDecision<T>(
  decision: ScanDecision<T>,
  onCommit: (product: T) => void,
  confirmFn: ConfirmFn,
): boolean {
  if (decision.kind === "add") {
    onCommit(decision.product);
    return true;
  }
  if (decision.kind === "confirm-suggestion") {
    const product = decision.product;
    confirmFn(decision.title, decision.message, () => onCommit(product), {
      confirmText: decision.confirmText,
    });
    return true;
  }
  return false;
}
