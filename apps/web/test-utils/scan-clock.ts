import { SCAN_KEY_GAP_MS } from "@/components/BarcodeScannerButton";

/**
 * SA-1159: the wedge detector measures the gap between keys with each keydown's `timeStamp`, and jsdom stamps an event when
 * user-event CREATES it, so a slow render after key 1 on a loaded CI box stretches the stamped gap past SCAN_KEY_GAP_MS and
 * the detector restarts the sequence (a lost leading digit). A test that types a scan code key by key calls this once: every
 * keydown is stamped `stepMs` after the one before it, whatever the wall clock did. An event that sets its own `timeStamp`
 * (the tests that pin the gap on purpose) keeps it. A keyup draws a stamp too, so two keydowns can be 2 x stepMs apart.
 * `advance(ms)` moves the clock on, so the next key is stamped that much later: a stall on purpose, in stamped time. Never reads Date.now() and never fakes timers.
 */
export function installScanClock(stepMs: number = SCAN_KEY_GAP_MS / 20): {
  advance: (ms: number) => void;
} {
  const stamps = new WeakMap<object, number>();
  let clock = 1_000_000;
  beforeEach(() => {
    Object.defineProperty(KeyboardEvent.prototype, "timeStamp", {
      configurable: true,
      get(this: object) {
        let ts = stamps.get(this);
        if (ts === undefined) {
          ts = clock += stepMs;
          stamps.set(this, ts);
        }
        return ts;
      },
    });
  });
  afterEach(() => {
    delete (KeyboardEvent.prototype as unknown as Record<string, unknown>).timeStamp;
  });
  return {
    advance(ms: number) {
      clock += ms;
    },
  };
}
