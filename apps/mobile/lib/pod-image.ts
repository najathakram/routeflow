/**
 * Shared POD image-transcode constants.
 *
 * Every producer of a POD photo data URL (the capture widget in
 * `components/PhotoCapture.tsx` and the stop-close rescue transcode in
 * `app/(driver)/route/stop/[stopId]/payment.tsx`) must resize/compress with
 * the SAME budget: a full-resolution 12MP camera JPEG is 1.5-3MB of binary,
 * ~1.33x that as base64, which blows past both server limits below.
 *
 * Pure constants only (no React Native imports) so the pure-logic Jest lane
 * can import this file.
 */

/** Long-edge width every POD capture is resized to before base64 encoding. */
export const DATA_URL_MAX_WIDTH = 1280;

/** JPEG quality used for POD data URLs — legible for dispute review, small. */
export const DATA_URL_JPEG_QUALITY = 0.6;

/**
 * Hard ceiling for a POD `dataUrl` string, mirroring the server's own cap:
 * `@MaxLength(1_900_000)` on `dataUrl` in
 * `apps/api/src/routes/dto/attach-pod-artifact.dto.ts` (itself under the 2MB
 * global JSON body limit set in `apps/api/src/main.ts`). A longer string is
 * treated as a conversion failure client-side rather than posted for a
 * guaranteed 400/413.
 */
export const MAX_POD_DATA_URL_LENGTH = 1_900_000;
