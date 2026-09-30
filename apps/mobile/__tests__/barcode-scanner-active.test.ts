/**
 * B263 (B246 Option B) / T3 (REG-B263-C) — `barcode-scanner-active.test.ts`
 *
 * `cause-ruling.md` §2 D1: `components/BarcodeScanner.tsx` and `.web.tsx`
 * accept `active?: boolean` (default `true`) and forward it into
 * `<ScanCamera active={active && !paused}>` — pausing the camera instead of
 * remounting it while a price sheet is stacked over the scanner — and both
 * render `feedback.action` as a pill button exactly as
 * `ScanOrderSheet.tsx:171-184` does (label from `action.label`, `onPress` →
 * `action.onPress`). No other mount of either component changes behaviour
 * (`active` defaults `true`).
 *
 * Source-text spec: nothing renders under mobile Jest (`jest.config.js:4/:11`),
 * so this reads both files as text and pins counted values, never a rendered
 * tree. Paths resolve from `__dirname`, never `process.cwd()`.
 *
 * Every assertion runs against a COMMENT-STRIPPED copy and, for the feedback
 * pill, a JSX window around the feedback block — the plan's harness note says
 * source-text specs must not match comments, and a whole-file grep for
 * `feedback.action` would be satisfied by a comment (red-gate audit
 * 2026-09-08).
 */
import { readFileSync } from "fs";
import { join } from "path";

const NATIVE_PATH = join(__dirname, "..", "components", "BarcodeScanner.tsx");
const WEB_PATH = join(__dirname, "..", "components", "BarcodeScanner.web.tsx");

/** Drop `/* … *\/` blocks (JSX `{/* … *\/}` comments included) and whole-line
 *  `//` comments, so no assertion below can be satisfied by prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const nativeSrc = stripComments(readFileSync(NATIVE_PATH, "utf8"));
const webSrc = stripComments(readFileSync(WEB_PATH, "utf8"));

/** Isolate the `<ScanCamera ...>` opening tag (both hosts use a multi-line,
 *  non-self-closing mount, so stop at the first `>` that isn't part of an
 *  attribute expression by bounding the window instead of matching `/>`). */
function scanCameraOpenTag(src: string): string {
  const match = src.match(/<ScanCamera\b[\s\S]{0,400}?\n\s{6}(?:onModeChange|\/>)/);
  return match ? match[0] : "";
}

/** The JSX window that renders the feedback pill — from the `{feedback ? (`
 *  guard both hosts use, bounded generously so an added action pill (and its
 *  own nested ternary) still falls inside it. Scoping here is what keeps the
 *  `.action` assertions from being a whole-file grep. */
function feedbackPillWindow(src: string): string {
  const start = src.indexOf("{feedback ? (");
  return start === -1 ? "" : src.slice(start, start + 900);
}

describe.each([
  ["BarcodeScanner.tsx (native)", NATIVE_PATH, nativeSrc],
  ["BarcodeScanner.web.tsx (web)", WEB_PATH, webSrc],
])("%s forwards active into ScanCamera (REG-B263-C)", (_label, _path, src) => {
  it("REG-B263-C: the ScanCamera mount receives an active= prop", () => {
    // TODAY: neither host's ScanCamera mount takes `active` at all — only
    // `style`, `onScanned`, `onOutcome`, `continuous` (+ web's `onModeChange`/
    // `footer`). Zero matches today.
    const cameraTag = scanCameraOpenTag(src);
    expect(cameraTag.length).toBeGreaterThan(0); // sanity: the mount still exists
    expect(cameraTag).toMatch(/active=\{/);
  });

  it("REG-B263-C: the active prop pauses the decode loop instead of just gating on active", () => {
    // Pins the polarity, not just presence: dropping `&& !paused` (leaving
    // only `active={active}`) must fail here even though the mount still has
    // an `active=` prop. Mirrors the `.action` polarity pin in
    // edit-items-scan-price.test.ts:63-70.
    const cameraTag = scanCameraOpenTag(src);
    const activeExprMatch = cameraTag.match(/active=\{([^}]*)\}/);
    expect(activeExprMatch).not.toBeNull();
    expect(activeExprMatch![1]).toMatch(/^\s*active\s*&&\s*!\s*paused\s*$/);
  });

  it("REG-B263-C: the feedback pill reads feedback.action", () => {
    // TODAY: neither host reads `.action` off its `feedback` state at all —
    // the feedback pill shows only an icon + `feedback.text` (REG-B263-C:
    // this is what strands the picker's paused-camera price edit with no
    // way back into the scanner). Zero matches today, inside the pill window.
    const pill = feedbackPillWindow(src);
    expect(pill.length).toBeGreaterThan(0); // sanity: the pill still exists
    expect(pill).toMatch(/feedback\.action/);
  });

  it("REG-B263-C: the feedback pill binds onPress to the action's own handler", () => {
    // Its own `it` so the `.action` read above cannot mask this oracle. The
    // pattern ScanOrderSheet.tsx:171-184 already uses for its error-pill
    // action. Zero matches today.
    const pill = feedbackPillWindow(src);
    expect(pill.length).toBeGreaterThan(0); // sanity: the pill still exists
    expect(pill).toMatch(/onPress=\{[^}]*\.action[^}]*\.onPress/);
  });
});
