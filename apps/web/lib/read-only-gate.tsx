"use client";

import * as React from "react";
import type { SubscriptionView } from "@routeflow/types";
import { Button, type ButtonProps } from "@routeflow/ui/web";
import { readOnlyLine } from "./subscription-banner-state";

/**
 * SA-733r6 (B4): while the workspace is read-only, the controls that WRITE (new order, new invoice, new estimate,
 * counter sale / Charge, record payment) stay VISIBLE but disabled, and say why in one fixed sentence right next to
 * them: "Not available while read-only. <Admin name> can restore it." Nothing is hidden (no feature loss). View,
 * search, print / PDF, export and the end-of-day close stay enabled - the server allow-list is the authority; this
 * only renders it.
 *
 * The shell provides the state from the one subscription read it already makes; outside the shell (tests, public
 * pages) the default is "not read-only", so a screen without the provider behaves exactly as before.
 */
interface Gate {
  readOnly: boolean;
  /** The fixed sentence, or null when writes are allowed. */
  line: string | null;
  /** The id of the ONE `ReadOnlyHint` a screen renders; gated controls point `aria-describedby` at it. */
  hintId: string;
}

// A 403 READ_ONLY on a control the page still thought was enabled flips the gate at once (before the subscription
// re-read lands) so the line appears NEXT TO that control, not only in a toast. It expires after a minute: the fresh
// read decides again, so a stale refusal (the server's status cache is 60 s) never sticks.
const REFUSAL_MS = 60_000;
let refusedUntil = 0;
let refusalTimer: ReturnType<typeof setTimeout> | null = null;
const refusalListeners = new Set<() => void>();
const notifyRefusal = () => refusalListeners.forEach((fn) => fn());

export function isReadOnlyRefused(): boolean {
  return refusedUntil > Date.now();
}
export function markReadOnlyRefused(): void {
  refusedUntil = Date.now() + REFUSAL_MS;
  if (refusalTimer) clearTimeout(refusalTimer);
  refusalTimer = setTimeout(notifyRefusal, REFUSAL_MS + 50);
  notifyRefusal();
}
export function resetReadOnlyRefusedForTests(): void {
  refusedUntil = 0;
  if (refusalTimer) clearTimeout(refusalTimer);
  refusalTimer = null;
  notifyRefusal();
}
const subscribeRefusal = (fn: () => void) => {
  refusalListeners.add(fn);
  return () => {
    refusalListeners.delete(fn);
  };
};

const GateContext = React.createContext<Gate>({ readOnly: false, line: null, hintId: "ro-line" });

export function ReadOnlyGateProvider({
  view,
  children,
}: {
  view: SubscriptionView | null | undefined;
  children: React.ReactNode;
}) {
  const refused = React.useSyncExternalStore(subscribeRefusal, isReadOnlyRefused, () => false);
  const readOnly = view?.status === "READ_ONLY" || refused;
  const name = view?.billingContactName;
  const hintId = React.useId();
  const value = React.useMemo<Gate>(
    () => ({ readOnly, line: readOnly ? readOnlyLine(name) : null, hintId }),
    [readOnly, name, hintId],
  );
  return <GateContext.Provider value={value}>{children}</GateContext.Provider>;
}

export function useReadOnlyGate(): Gate {
  return React.useContext(GateContext);
}

/**
 * A button that WRITES. While read-only it stays in the DOM, disabled, pointing at the screen's one
 * `ReadOnlyHint`; a link-style button (`href`) becomes a plain disabled button so it cannot navigate.
 */
export function WriteButton({ href, onClick, disabled, ...rest }: ButtonProps) {
  const gate = useReadOnlyGate();
  if (gate.readOnly) {
    return (
      <Button {...rest} disabled aria-describedby={gate.hintId} title={gate.line ?? undefined} />
    );
  }
  return <Button {...rest} href={href} onClick={onClick} disabled={disabled} />;
}

/** The line next to a disabled control. Controls are `WriteButton`s. */
export function ReadOnlyHint({ className }: { className?: string }) {
  const gate = useReadOnlyGate();
  if (!gate.readOnly || !gate.line) return null;
  return (
    <p
      id={gate.hintId}
      data-testid="read-only-line"
      className={className ?? "mt-1 text-xs text-slate-600"}
    >
      {gate.line}
    </p>
  );
}
