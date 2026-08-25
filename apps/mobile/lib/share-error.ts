/**
 * Pure classification of a `navigator.share()` rejection — extracted from
 * share-pdf.ts so the iOS contract below is unit-testable (this module must
 * stay free of react-native imports; the mobile Jest env is node-only).
 *
 * The three outcomes mirror share-pdf.ts's ShareOutcome semantics:
 *
 *  - `"dismissed"` (AbortError): the user closed the OS share sheet. Not an
 *    error; the Web Share API cannot distinguish "sent" from "cancelled".
 *  - `"retap"` (NotAllowedError): **the iOS Safari case.** `share()` requires
 *    transient user activation, and Safari's activation window frequently
 *    does NOT survive the PDF fetch that has to happen first — WebKit rejects
 *    with NotAllowedError even though the file is downloaded and ready. The
 *    correct response is the same as a budget expiry: keep the cached file
 *    and ask for ONE fresh tap, which shares it synchronously (per the Web
 *    Share spec's own guidance to separate async prep from the share tap).
 *    Treating this as a hard failure is exactly the "share works on desktop
 *    but not on the phone" bug (desktop browsers take the window.open
 *    fallback and never call share()).
 *  - `"failed"`: everything else — a real failure worth a toast.
 */
export type ShareErrorKind = "dismissed" | "retap" | "failed";

export function classifyShareError(errName: string | undefined | null): ShareErrorKind {
  if (errName === "AbortError") return "dismissed";
  if (errName === "NotAllowedError") return "retap";
  return "failed";
}
