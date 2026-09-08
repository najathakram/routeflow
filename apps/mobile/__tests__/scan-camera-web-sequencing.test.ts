/**
 * B245 pin (no REG token — outside the red gate) — `scan-camera-web-sequencing.test.ts`
 *
 * `cause-ruling.md` §3: B245 alleged the web scanner's frame decode, resolve
 * and camera-teardown sequencing could race. Mobile Jest is pure-logic node
 * (`jest.config.js:4/:11`) with no web renderer, so this cannot exercise the
 * sequencing behaviourally (L-025: a `Platform`/web branch is untested code
 * unless something runs that platform) — it pins the five call sites S1
 * named as source-text assertions instead, discharging B245 as "pinned by
 * source assertion; behavioural coverage needs a web renderer".
 *
 * Source-text spec in the style of `scan-camera-buffer.test.ts:141-155`.
 * Each assertion is a count >= 1 against the literal call sites (today's
 * values, per cause-ruling.md §3: `handleFrame` in `.then()` `:337-338`,
 * the `inFlightRef` release in `.finally()` `:341-344`, the `scanSettled`
 * drain `:248-252`, `playScanCue` `:245`, plus `track.stop()` reached from
 * the unmount cleanup). Regexes tolerate prettier line-wrapping with `\s*`.
 *
 * NOTE: green-by-design pin (B245). Not part of the REG-B246 red gate; the
 * gate command is `npx jest --runInBand -t "REG-B246"`, which excludes every
 * test in this file (no REG token in any title). These assertions pin
 * behaviour that already exists in `components/ScanCamera.web.tsx` — they are
 * expected to PASS today and must not be rewritten to fail, since that would
 * mean asserting something false. Recorded in `bug-test-plan.md` under
 * "Pins (no REG token, outside the red gate)".
 */
import { readFileSync } from "fs";
import { join } from "path";

const source = readFileSync(join(__dirname, "..", "components", "ScanCamera.web.tsx"), "utf8");

describe("ScanCamera.web.tsx frame/resolve/teardown sequencing (B245 pin)", () => {
  it("B245: decode resolves handleFrame from inside a .then( block, not synchronously", () => {
    const thenMatches =
      source.match(/\.then\s*\(\s*\(\s*code\s*\)\s*=>\s*\{[\s\S]{0,120}?\}/g) ?? [];
    const thenWithHandleFrame = thenMatches.filter((block) => /handleFrame\s*\(/.test(block));
    expect(thenWithHandleFrame.length).toBeGreaterThanOrEqual(1);
  });

  it("B245: the in-flight guard is released inside a .finally( block, so it clears even on a rejected decode", () => {
    const finallyMatches =
      source.match(/\.finally\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,200}?\}\s*\)/g) ?? [];
    const finallyWithRelease = finallyMatches.filter((block) =>
      /inFlightRef\.current\s*=\s*false/.test(block),
    );
    expect(finallyWithRelease.length).toBeGreaterThanOrEqual(1);
  });

  // Title says "at least once" deliberately: this is a bare occurrence count
  // over the file, so it pins that the drain call site exists — it asserts
  // nothing about ordering relative to the resolved-outcome return.
  it("B245: scanSettled is called at least once to drain the engine", () => {
    const scanSettledCalls = source.match(/scanSettled\s*\(/g) ?? [];
    expect(scanSettledCalls.length).toBeGreaterThanOrEqual(1);
  });

  // Same shape: an occurrence count, not per-outcome coverage.
  it("B245: playScanCue is called at least once for the accept/reject cue", () => {
    const playScanCueCalls = source.match(/playScanCue\s*\(/g) ?? [];
    expect(playScanCueCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("B245: the camera track is stopped when the scanner unmounts", () => {
    // `stop()` (the function that iterates `streamRef.current.getTracks()`
    // and calls `track.stop()` on each) is invoked from the effect's
    // cleanup — `return () => { cancelled = true; stop(); };` — so both the
    // literal teardown call AND the cleanup wiring to it are pinned.
    const tracksStopped = source.match(/track\.stop\s*\(\s*\)/g) ?? [];
    const cleanupCallsStop =
      /return\s*\(\)\s*=>\s*\{[\s\S]{0,80}?stop\s*\(\s*\)\s*;[\s\S]{0,40}?\}/.test(source);
    expect(tracksStopped.length).toBeGreaterThanOrEqual(1);
    expect(cleanupCallsStop).toBe(true);
  });
});
