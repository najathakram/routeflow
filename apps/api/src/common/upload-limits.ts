/**
 * Shared multipart limits for every FileInterceptor / FilesInterceptor in the API.
 *
 * WHY THIS EXISTS
 * multer's field parser turns a bracket group of digits into an array index, so a
 * single field named `a[999999999]` materialises a sparse array of that length.
 * Building it is cheap; the app pays when it later iterates or serialises
 * `req.body`, which blocks the event loop (CVE-2026-82333 / GHSA-535w-7cp7-47q4).
 *
 * ⚠️ Upgrading multer does NOT fix this. The guard shipped in 2.3.0 is OPT-IN:
 * `lib/make-middleware.js` only checks the limit when the key is actually present
 * (`Object.prototype.hasOwnProperty.call(limits, 'fieldArrayIndexLimit')`), and it
 * defaults to Infinity. Every upload route therefore has to pass it — which is why
 * this helper exists rather than sixteen hand-written literals that can drift.
 *
 * ⚠️ `fieldArrayIndexLimit` is NOT in the `MulterOptions.limits` type. That type is
 * declared by @nestjs/platform-express itself (NOT by @types/multer, which is a red
 * herring here) as a closed literal of seven keys, and @types/multer@2.2.0 is the
 * newest published version — no types declare the key. Returning a pre-built object
 * with an INFERRED type is what keeps this both compiling and assertion-free:
 * TypeScript's excess-property check only fires on a *fresh* object literal at the
 * assignment site, so `limits: uploadLimits(N)` compiles where
 * `limits: { …, fieldArrayIndexLimit }` does not. That is a deliberate, load-bearing
 * detail, not an accident of style — do not "simplify" it back to an inline literal,
 * do not annotate this function's return type (that re-introduces the error inside
 * the function and invites an `as` cast), and do not reach for `any`.
 *
 * The runtime side is safe: FileInterceptor does `multer({ ...options, ...localOptions })`
 * with no key filtering, so an unknown limits key reaches multer verbatim.
 */

/** Largest array index any RouteFlow client sends inside a multipart field name. */
const MAX_FIELD_ARRAY_INDEX = 100;

/** Deepest bracket nesting any RouteFlow client sends (`a[b]` is one level). */
const MAX_FIELD_NESTING_DEPTH = 5;

/**
 * Build the `limits` object for an upload route.
 *
 * Every RouteFlow client sends multipart text fields as plain repeated names
 * (`focalX`, `focalX`), never bracket-indexed — so no shipped caller comes near
 * these ceilings. They exist to bound an attacker, not to describe our own traffic.
 *
 * @param fileSizeBytes per-file cap for this route, in bytes.
 */
export function uploadLimits(fileSizeBytes: number) {
  return {
    fileSize: fileSizeBytes,
    fieldNestingDepth: MAX_FIELD_NESTING_DEPTH,
    fieldArrayIndexLimit: MAX_FIELD_ARRAY_INDEX,
  };
}

/** Byte helper so call sites read as `uploadLimits(MB(10))` rather than `10 * 1024 * 1024`. */
export function MB(n: number): number {
  return n * 1024 * 1024;
}
