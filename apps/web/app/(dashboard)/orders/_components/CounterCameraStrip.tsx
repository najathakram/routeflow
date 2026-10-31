"use client";

import * as React from "react";
import { X, Zap, ZapOff } from "lucide-react";
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
 * Time spent blocked is added to an offset and taken off `now()`, so a pause is no time at all to the engine, with two limits:
 *  - a block that came from dropped frames (the clerk typing elsewhere, a dialog) froze only up to the LAST frame dropped: the
 *    code was in view until then. What came after it, with no frame at all, is real time, so a code that was taken away for 5 s
 *    and brought back is a new scan;
 *  - a hard block (the camera is off, or a receipt is up) sends no frames, so nothing says the code left: it freezes right up
 *    to the first frame accepted afterwards (the camera takes a moment to deliver one once it is back on).
 * Either way the block ends only on an accepted frame, never on the camera coming back.
 */
export function createPausableClock(read: () => number = Date.now) {
  let offset = 0;
  let since: number | null = null;
  let lastDropped: number | null = null;
  let hard = false;
  return {
    now: () => (since === null ? read() - offset : since - offset),
    /** A hard block: no frames are coming (camera off, receipt up). Frozen until the first accepted frame. */
    block: () => {
      if (since === null) since = read();
      hard = true;
    },
    /** A frame arrived and was dropped: the code was in view at least until now. */
    drop: () => {
      const t = read();
      if (since === null) since = t;
      lastDropped = t;
    },
    /** An accepted frame: the block, if any, is over. */
    unblock: () => {
      if (since !== null) offset += (hard || lastDropped === null ? read() : lastDropped) - since;
      since = null;
      lastDropped = null;
      hard = false;
    },
  };
}

export type PausableClock = ReturnType<typeof createPausableClock>;

/**
 * The camera's engine state and clock, held by the SCREEN rather than the strip: the strip is unmounted while a receipt is up
 * (and remounts for the next sale), but an item still in front of the lens when the clerk taps New sale is the same item and
 * must not count again. Stable for the life of the screen.
 */
export type CameraScanEngine = { state: ContinuousScanState; clock: PausableClock };
export function useCameraScanEngine(): CameraScanEngine {
  const ref = React.useRef<CameraScanEngine | null>(null);
  if (!ref.current)
    ref.current = { state: createContinuousScanState(), clock: createPausableClock() };
  return ref.current;
}

/**
 * SA-1059: the counter's continuous camera. It feeds the SAME scan queue as the wedge (`onCode` -> `scan.submitCamera`), so
 * this component owns only the picture. The engine state and its clock are the screen's (`engine`): they survive this strip
 * being unmounted for a receipt. `enabled` is the screen's pause (receipt, locked cart, a picker or a retry waiting): the strip
 * stays mounted through it, so a code still held in view does not count twice. `frameBlocked` drops a frame while the clerk is
 * typing elsewhere or a dialog is open.
 */
export function CounterCameraStrip({
  engine,
  enabled,
  frameBlocked,
  onCode,
  added,
  onClose,
}: {
  engine: CameraScanEngine;
  enabled: boolean;
  frameBlocked: () => boolean;
  onCode: (code: string) => void;
  /** The scan box's confirmation ("Added Cola"), drawn on the picture; the status region below the field announces it. */
  added?: string;
  /** Close camera (bottom-left): the screen's own toggle. */
  onClose?: () => void;
}) {
  const { clock } = engine;
  // Paused while frames are dropped as well as while the camera is off, so the clerk sees why a code does nothing. Set only
  // when it changes: a frame arrives many times a second.
  const [dropping, setDropping] = React.useState(false);
  const droppingRef = React.useRef(false);
  const enabledRef = React.useRef(enabled);
  enabledRef.current = enabled;
  const frameBlockedRef = React.useRef(frameBlocked);
  frameBlockedRef.current = frameBlocked;
  const onCodeRef = React.useRef(onCode);
  onCodeRef.current = onCode;

  // Pausing stops the clock; resuming does not start it: the first ACCEPTED frame does (see the clock).
  React.useEffect(() => {
    if (!enabled) clock.block();
  }, [enabled, clock]);

  const handleFrame = React.useCallback(
    (code: string, frame?: ScanFrame) => {
      if (!enabledRef.current || frameBlockedRef.current()) {
        clock.drop(); // a frame dropped is time the engine never lived through
        if (!droppingRef.current) {
          droppingRef.current = true;
          setDropping(true);
        }
        return;
      }
      if (droppingRef.current) {
        droppingRef.current = false;
        setDropping(false);
      }
      clock.unblock();
      // The aim box and steady read run ahead of the gate (owner ruling 2026-09-24). fastRepeat: SA-1059 extends the 2026-10-14
      // repeat-gap ruling (the order builder's) to the counter: the same item scanned again and again.
      let step = continuousFrameScanned(engine.state, code, clock.now(), {
        bounds: frame?.bounds,
        aimBox: frame?.aimBox,
        fastRepeat: true,
      });
      engine.state = step.next;
      // The counter's queue owns the waiting, so the engine's own resolve is settled at once.
      while (step.startResolving) {
        onCodeRef.current(step.startResolving);
        step = scanSettled(engine.state);
        engine.state = step.next;
      }
    },
    [clock, engine],
  );

  const camera = useContinuousScanCamera({ enabled, onDetect: handleFrame });

  return (
    <div data-testid="counter-camera-strip" className="pb-1">
      <ScanViewfinder camera={camera}>
        {!enabled || dropping ? (
          <p
            role="status"
            className="absolute inset-x-0 top-0 bg-black/70 px-2 py-1 text-center text-xs text-white"
          >
            Camera paused
          </p>
        ) : null}
        {added ? (
          <p
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-12 bottom-2 truncate rounded bg-black/70 px-2 py-1 text-center text-xs font-medium text-white"
            data-testid="counter-camera-added"
          >
            {added}
          </p>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close camera"
            className="absolute bottom-1 left-1 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
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
