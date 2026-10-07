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
  options?: { confirmText?: string; destructive?: boolean; onCancel?: () => void },
) => void;

/**
 * Opens a list of EVERY fuzzy match (injected — `useScanMatchPicker().open`). A row's confirm
 * button calls `onCommit(row)`; dismissing the list calls `onCancel`. Nothing commits otherwise.
 */
export type PickMatchFn<T = any> = (
  matches: T[],
  confirmText: string,
  onCommit: (product: T) => void,
  onCancel: () => void,
) => void;

export interface RunScanOptions<T = any> {
  /** Required to handle `pick-from-list`; without it that decision is left to the caller. */
  pick?: PickMatchFn<T>;
  /** true while a confirm/picker is open, false once it commits or is dismissed (pauses scanning). */
  onPromptChange?: (open: boolean) => void;
}

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
  | { kind: "pick-from-list"; matches: T[]; confirmText: "Add" | "Apply" }
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
  if (result.ambiguous) {
    return {
      kind: "pick-from-list",
      matches: result.matches ?? [],
      confirmText: screen === "stock" ? "Apply" : "Add",
    };
  }
  return { kind: "add", product: result.product };
}

/**
 * Commit now for a plain add; for a suggestion, only after the user confirms via `confirmFn`
 * (pass `confirm` from `./confirm`); for several matches, only after a row is chosen in the list
 * `options.pick` opens. Returns true when the decision was handled here.
 */
export function runScanDecision<T>(
  decision: ScanDecision<T>,
  onCommit: (product: T) => void,
  confirmFn: ConfirmFn,
  options: RunScanOptions<T> = {},
): boolean {
  const setOpen = options.onPromptChange ?? (() => undefined);
  if (decision.kind === "add") {
    onCommit(decision.product);
    return true;
  }
  if (decision.kind === "confirm-suggestion") {
    const product = decision.product;
    setOpen(true);
    confirmFn(
      decision.title,
      decision.message,
      () => {
        setOpen(false);
        onCommit(product);
      },
      { confirmText: decision.confirmText, onCancel: () => setOpen(false) },
    );
    return true;
  }
  if (decision.kind === "pick-from-list" && options.pick) {
    setOpen(true);
    options.pick(
      decision.matches,
      decision.confirmText,
      (p) => {
        setOpen(false);
        onCommit(p);
      },
      () => setOpen(false),
    );
    return true;
  }
  return false;
}

/** Scanner banner text while a confirm / picker prompt is waiting on the user. */
export function promptText(decision: ScanDecision): string {
  if (decision.kind === "confirm-suggestion") return `Confirm: ${decision.message}`;
  if (decision.kind === "pick-from-list") {
    return `${decision.matches.length} products match — choose one`;
  }
  return "";
}
