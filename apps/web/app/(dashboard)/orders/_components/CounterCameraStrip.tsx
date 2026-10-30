"use client";

import * as React from "react";
import { Zap, ZapOff } from "lucide-react";
import {
  continuousFrameScanned,
  createContinuousScanState,
  scanSettled,
  type ContinuousScanState,
} from "@routeflow/scanning";
import { ScanViewfinder } from "./scan/ScanViewfinder";
import { useContinuousScanCamera, type ScanFrame } from "./scan/useContinuousScanCamera";

/**
 * A clock that stops while scanning is blocked. The engine reads "absent" off the `now` it is given (a code unseen for 0.6 s
 * counts again), so with the camera off or frames dropped a code still held in view would look absent and recount on resume.
 * Time spent blocked is added to an offset and taken off `now()`, so a pause is no time at all to the engine.
 */
function createPausableClock(read: () => number = Date.now) {
  let offset = 0;
  let since: number | null = null;
  return {
    now: () => read() - offset - (since === null ? 0 : read() - since),
    block: () => {
      if (since === null) since = read();
    },
    unblock: () => {
      if (since !== null) offset += read() - since;
      since = null;
    },
  };
}

/**
 * SA-1059: the counter's continuous camera. It feeds the SAME scan queue as the wedge (`onCode` -> `scan.submitCamera`), so
 * this component owns only the picture and the engine state. `enabled` is the screen's pause (receipt, locked cart, a picker or
 * a retry waiting): the strip stays mounted, so the engine state survives and a code still held in view does not count twice.
 * `frameBlocked` drops a frame while the clerk is typing elsewhere or a dialog is open.
 */
export function CounterCameraStrip({
  enabled,
  frameBlocked,
  onCode,
}: {
  enabled: boolean;
  frameBlocked: () => boolean;
  onCode: (code: string) => void;
}) {
  const engineRef = React.useRef<ContinuousScanState>(createContinuousScanState());
  const clockRef = React.useRef<ReturnType<typeof createPausableClock> | null>(null);
  if (!clockRef.current) clockRef.current = createPausableClock();
  const clock = clockRef.current;
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const frameBlockedRef = React.useRef(frameBlocked);
  frameBlockedRef.current = frameBlocked;
  const onCodeRef = React.useRef(onCode);
  onCodeRef.current = onCode;

  React.useEffect(() => {
    if (enabled) clock.unblock();
    else clock.block();
  }, [enabled, clock]);

  const handleFrame = React.useCallback(
    (code: string, frame?: ScanFrame) => {
      if (!enabledRef.current || frameBlockedRef.current()) {
        clock.block(); // a frame dropped is time the engine never lived through
        return;
      }
      clock.unblock();
      // The aim box and steady read run ahead of the gate (owner ruling 2026-09-24). fastRepeat: SA-1059 extends the 2026-10-14
      // repeat-gap ruling (the order builder's) to the counter: the same item scanned again and again.
      let step = continuousFrameScanned(engineRef.current, code, clock.now(), {
        bounds: frame?.bounds,
        aimBox: frame?.aimBox,
        fastRepeat: true,
      });
      engineRef.current = step.next;
      // The counter's queue owns the waiting, so the engine's own resolve is settled at once.
      while (step.startResolving) {
        onCodeRef.current(step.startResolving);
        step = scanSettled(engineRef.current);
        engineRef.current = step.next;
      }
    },
    [clock],
  );

  const camera = useContinuousScanCamera({ enabled, onDetect: handleFrame });

  return (
    <div data-testid="counter-camera-strip" className="pb-1">
      <ScanViewfinder camera={camera}>
        {!enabled ? (
          <p
            role="status"
            className="absolute inset-x-0 top-0 bg-black/70 px-2 py-1 text-center text-xs text-white"
          >
            Camera paused
          </p>
        ) : null}
        {camera.torchAvailable ? (
          <button
            type="button"
            onClick={camera.toggleTorch}
            aria-pressed={camera.torchOn}
            aria-label={camera.torchOn ? "Turn flashlight off" : "Turn flashlight on"}
            className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white"
          >
            {camera.torchOn ? <Zap className="h-5 w-5" /> : <ZapOff className="h-5 w-5" />}
          </button>
        ) : null}
      </ScanViewfinder>
    </div>
  );
}
