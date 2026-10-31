"use client";

import * as React from "react";
import { X, Zap, ZapOff } from "lucide-react";
import {
  continuousFrameScanned,
  createContinuousScanState,
  createPausableClock,
  scanSettled,
  type ContinuousScanState,
  type PausableClock,
} from "@routeflow/scanning";
import { CounterBuyerLine } from "./CounterBuyerChoice";
import type { BuyerKind } from "./counter-buyer-choice";
import { ScanViewfinder } from "./scan/ScanViewfinder";
import { useContinuousScanCamera, type ScanFrame } from "./scan/useContinuousScanCamera";

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

/** SA-1071 K1: how long "Move it away to add another" stays after the last frame of the held code. */
const HELD_CUE_MS = 1000;

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
  onUndo,
  onClose,
  buyer,
}: {
  engine: CameraScanEngine;
  enabled: boolean;
  frameBlocked: () => boolean;
  onCode: (code: string) => void;
  /** The scan box's confirmation ("Added Cola"), drawn on the picture; the status region below the field announces it. */
  added?: string;
  /** SA-1071 K3: takes the latest read back; drawn beside `added` for as long as it shows. Absent = no button. */
  onUndo?: () => void;
  /** Close camera (bottom-left): the screen's own toggle. */
  onClose?: () => void;
  /** Who is buying, as one line above the picture (below md only); omitted before the question is answered. */
  buyer?: { kind: BuyerKind; name?: string };
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
  // SA-1071 K1: the same code still in view after it counted. State changes only on the edge: a frame arrives many times a second.
  const [held, setHeld] = React.useState(false);
  const heldRef = React.useRef(false);
  const heldTimerRef = React.useRef<number | null>(null);
  const setHeldCue = React.useCallback((on: boolean) => {
    if (heldTimerRef.current !== null) window.clearTimeout(heldTimerRef.current);
    heldTimerRef.current = null;
    if (on) heldTimerRef.current = window.setTimeout(() => setHeldCue(false), HELD_CUE_MS);
    if (heldRef.current !== on) {
      heldRef.current = on;
      setHeld(on);
    }
  }, []);
  React.useEffect(
    () => () => {
      if (heldTimerRef.current !== null) window.clearTimeout(heldTimerRef.current);
    },
    [],
  );

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
        signalHeld: true,
      });
      engine.state = step.next;
      if (step.held) setHeldCue(true);
      else if (step.startResolving) setHeldCue(false);
      // The counter's queue owns the waiting, so the engine's own resolve is settled at once.
      while (step.startResolving) {
        onCodeRef.current(step.startResolving);
        step = scanSettled(engine.state);
        engine.state = step.next;
      }
    },
    [clock, engine, setHeldCue],
  );

  const camera = useContinuousScanCamera({ enabled, onDetect: handleFrame });

  return (
    <div data-testid="counter-camera-strip" className="pb-1">
      {buyer ? <CounterBuyerLine kind={buyer.kind} customerName={buyer.name} /> : null}
      <ScanViewfinder camera={camera}>
        {!enabled || dropping ? (
          <p
            role="status"
            className="absolute inset-x-0 top-0 bg-black/70 px-2 py-1 text-center text-xs text-white"
          >
            Camera paused
          </p>
        ) : null}
        {held && enabled && !dropping ? (
          <p
            role="status"
            className="pointer-events-none absolute inset-x-0 top-0 bg-black/70 px-2 py-1 text-center text-xs text-white"
            data-testid="counter-camera-held"
          >
            Move it away to add another
          </p>
        ) : null}
        {added ? (
          <div className="pointer-events-none absolute inset-x-12 bottom-1 flex items-center justify-center gap-2">
            <p
              aria-hidden="true"
              className="min-w-0 truncate rounded bg-black/70 px-2 py-1 text-center text-xs font-medium text-white"
              data-testid="counter-camera-added"
            >
              {added}
            </p>
            {onUndo ? (
              <button
                type="button"
                onClick={onUndo}
                className="pointer-events-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-white px-3 text-xs font-semibold text-navy"
              >
                Undo
              </button>
            ) : null}
          </div>
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
