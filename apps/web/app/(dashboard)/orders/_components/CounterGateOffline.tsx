"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";
import {
  COUNTER_GATE_CHECK_FAILED_COPY,
  COUNTER_GATE_STILL_OFFLINE_COPY,
} from "@/lib/counter-sale";

/** How long the button says "Retrying..." when the retry cannot even start (still offline: the request stays paused). */
const RETRY_FEEDBACK_MS = 2500;

/**
 * CQ-30: shown when the counter-sale capability lookup FAILED or could not start (no network, a server error). It is not the
 * "not turned on" answer, which only a successful lookup may give. No sale UI renders. Retry asks again and gives feedback
 * while it works: disabled and "Retrying..."; if the answer does not come (still offline) it says so and can be pressed again.
 * When the connection returns the paused lookup resumes by itself and the screen opens.
 */
export function CounterGateOffline({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void | Promise<unknown>;
  /** the gate's own refetch is running */
  retrying?: boolean;
}) {
  const [pressed, setPressed] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const busy = pressed || retrying;
  const press = () => {
    if (busy) return;
    setPressed(true);
    setTried(false);
    void onRetry();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setPressed(false);
      setTried(true);
    }, RETRY_FEEDBACK_MS);
  };
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-start gap-3 p-4 text-sm"
      data-testid="counter-sale-offline"
    >
      <p>{COUNTER_GATE_CHECK_FAILED_COPY}</p>
      {tried && !busy ? (
        <p data-testid="counter-sale-offline-still">{COUNTER_GATE_STILL_OFFLINE_COPY}</p>
      ) : null}
      <Button className="min-h-[44px]" disabled={busy} aria-busy={busy} onClick={press}>
        {busy ? "Retrying\u2026" : "Retry"}
      </Button>
    </div>
  );
}
