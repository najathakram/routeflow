/**
 * T4 (bug-test-plan.md) — REG-B111: POD photo attach failures swallowed.
 *
 * Design of record: cause-ruling.md §1/§3 D4, at payment.tsx today:
 *
 *   const podPhotos = (pod?.photoUrls ?? []).filter((p) => p.startsWith("data:"));
 *   for (const dataUrl of podPhotos) {
 *     try {
 *       await attachPodMut.mutateAsync({ runId, stopId, kind: "photo", dataUrl,
 *         artifactId: podPhotoArtifactId(dataUrl) });
 *     } catch {
 *       // offline-queued or failed — the stop completion must proceed either way
 *     }
 *   }
 *
 * Two legs: (A) a `file://` fallback photo (PhotoCapture.tsx's transcode-
 * failure fallback, components/PhotoCapture.tsx:66-68) is silently FILTERED
 * OUT by `startsWith("data:")` and never sent at all; (B) the bare `catch {}`
 * swallows a genuine attach failure of a `data:` photo with zero signal. The
 * fix (D4) converts rather than drops the file:// fallback, and the catch
 * surfaces the failure (toast/inline + a failedActions queue entry) instead
 * of silently continuing.
 *
 * Source-text spec (mobile Jest has no renderer): comment-stripped, and every
 * assertion below is scoped to the podPhotos attach loop specifically — not
 * a whole-file grep — so a match elsewhere in the file can't satisfy it.
 */
import { readFileSync } from "fs";
import { join } from "path";

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const PAYMENT_PATH = join(
  __dirname,
  "..",
  "app",
  "(driver)",
  "route",
  "stop",
  "[stopId]",
  "payment.tsx",
);

const paymentSrc = stripComments(readFileSync(PAYMENT_PATH, "utf8"));

// Isolate the podPhotos attach loop specifically (bounded by two literal
// anchors either side of it) so neither assertion can be satisfied by an
// unrelated filter/catch elsewhere in this large screen. A miss is a HARNESS
// failure, not a test result: throwing at module scope fails the whole suite
// as a setup error (the anchors moved) instead of contributing a green test.
const attachLoopMatch = paymentSrc.match(/const podPhotos[\s\S]*?const idempotencyKey/);
if (!attachLoopMatch) {
  throw new Error("payment.tsx podPhotos attach loop not found — update the anchors");
}
const attachLoop = attachLoopMatch[0];

describe("REG-B111-A: file:// fallback photos are not filtered out of the attach loop", () => {
  it('no longer drops every photo that isn\'t already a data: URL — TODAY: .filter((p) => p.startsWith("data:")) is present', () => {
    const dataOnlyFilter =
      /\.filter\(\s*\(?\s*p\s*\)?\s*=>\s*p\.startsWith\(\s*["'`]data:["'`]\s*\)\s*\)/;
    expect(attachLoop).not.toMatch(dataOnlyFilter);
  });
});

describe("REG-B111-B: an attach failure is surfaced, never a silent empty catch", () => {
  it("the catch body is non-empty and references both error feedback and the offline queue — TODAY: bare `catch {}`", () => {
    const catchMatch = attachLoop.match(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}\s*\}/);
    const catchBody = catchMatch ? catchMatch[1].trim() : "";

    // TODAY this is empty (only a comment, already stripped) — the gating
    // assertion that fails cleanly before the more specific checks below.
    expect(catchBody).not.toBe("");

    // Feedback: this file's own existing error-display path (setAmountError,
    // already used above for the delivery/regulated-pod validation errors)
    // or the codebase's standard toast/alert primitives.
    expect(catchBody).toMatch(/setAmountError|showToast|alertInfo|Alert\.alert/);

    // Queue: the failure must be persisted where the operator can see it —
    // the same failedActions mechanism REG-B143/B111's queue drain already
    // uses (offline-queue-failed.test.ts), not just a toast that vanishes.
    expect(catchBody).toMatch(/addFailedAction|useOfflineQueue|enqueue/);
  });
});

describe("REG-B111-C: file:// captures are converted before attach, never sent raw", () => {
  it("the attach loop converts through podPhotoToDataUrl and never attaches a raw uri as dataUrl", () => {
    expect(attachLoop).toMatch(/podPhotoToDataUrl\s*\(/);
    // TODAY (pre-fix) this would be satisfied trivially since the raw `file://`
    // capture is filtered out before ever reaching a `dataUrl:` field — this
    // pins that a bypass of the converter (attaching `rawUrl` directly) can't
    // sneak back in once the filter above is gone.
    expect(attachLoop).not.toMatch(/dataUrl:\s*rawUrl\b/);
  });
});

describe("REG-B111-D: a conversion failure is surfaced and the capture is kept", () => {
  it("the conversion-failure branch records unsentUris and a failedActions entry", () => {
    expect(attachLoop).toMatch(/unsentUris\.push\(/);
    expect(attachLoop).toMatch(/addFailedAction\s*\(/);
  });
});

describe("REG-B111-E: attaches reconcile against the server's existing artifacts", () => {
  it("the attach loop dedupes candidates through pendingPodArtifacts + artifactIdsFromPodPhotoUrls", () => {
    expect(attachLoop).toMatch(/pendingPodArtifacts\s*\(/);
    expect(attachLoop).toMatch(/artifactIdsFromPodPhotoUrls\s*\(/);
  });
});

describe("REG-B111-F: the converter resizes and caps the data URL to the server's budget", () => {
  it("podPhotoToDataUrl resizes to DATA_URL_MAX_WIDTH and enforces MAX_POD_DATA_URL_LENGTH", () => {
    const converterMatch = paymentSrc.match(/const podPhotoToDataUrl[\s\S]*?(?=const podPhotos)/);
    if (!converterMatch) {
      throw new Error("payment.tsx podPhotoToDataUrl definition not found — update the anchors");
    }
    const converter = converterMatch[0];
    expect(converter).toMatch(/resize\s*:\s*\{\s*width\s*:\s*DATA_URL_MAX_WIDTH/);
    expect(converter).toMatch(/MAX_POD_DATA_URL_LENGTH/);
  });
});

// The photo.tsx counterpart guard ("photo.tsx does not itself drop file:// URIs")
// asserts a property the file ALREADY satisfies, so it is green before and after
// the fix: it lives in `session-teardown.pins.test.ts` with this package's other
// pin, which the red gate excludes via --testPathIgnorePatterns pins.
