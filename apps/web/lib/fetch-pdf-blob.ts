/**
 * Fetch a PDF (or any file) URL as a Blob, attaching auth when the URL is
 * served by our own API and skipping it when it's an external presigned URL.
 *
 * The previous logic ("relative → use apiClient, absolute → use bare axios")
 * worked when the API only ever returned bare-path URLs for local storage.
 * `StorageService.presignedUrl` actually returns
 *   `${publicBaseUrl}/api/v1/uploads/<key>`
 * for the local backend, which IS absolute but still needs the JWT — so the
 * old branch routed it through unauth'd axios and the upload endpoint
 * returned 401.
 *
 * The new rule compares the URL's origin against the AUTH CLIENT's runtime
 * `baseURL`, not a build-time `process.env.NEXT_PUBLIC_API_URL` constant.
 * The earlier version of this helper used the build-time env, which silently
 * defaulted to `http://localhost:3000/api/v1` when the Next.js build didn't
 * receive the env var — and even though apiClient itself was correctly
 * pointed at the prod API at runtime (Next.js inlines the env var at build,
 * but the dev fallback bites if the var wasn't set during that build),
 * the helper compared the wrong origin and routed every PDF download
 * through unauth'd axios → 401. Reading `authClient.defaults.baseURL`
 * uses the SAME baseURL the rest of the client uses, so we always agree.
 *
 *   - Same-origin as the auth client's baseURL → route through the auth'd
 *     client (it auto-attaches the Bearer token via interceptor; absolute
 *     URLs are respected by axios and bypass baseURL prepending).
 *   - Different origin (R2 / S3 presigned) → bare axios, no auth header.
 *   - Relative path (legacy callers) → auth'd client.
 */
import type { AxiosInstance } from "axios";
import axios from "axios";

function originOf(maybeUrl: string | null | undefined): string | null {
  if (!maybeUrl) return null;
  try {
    return new URL(maybeUrl).origin;
  } catch {
    return null;
  }
}

export async function fetchPdfBlob(url: string, authClient: AxiosInstance): Promise<Blob> {
  const isAbsolute = /^https?:\/\//i.test(url);
  const urlOrigin = isAbsolute ? originOf(url) : null;
  const clientOrigin = originOf(authClient.defaults.baseURL);
  const isOurApi =
    !isAbsolute || (urlOrigin !== null && clientOrigin !== null && urlOrigin === clientOrigin);

  if (isOurApi) {
    const r = await authClient.get<Blob>(url, { responseType: "blob" });
    return r.data;
  }
  const r = await axios.get<Blob>(url, { responseType: "blob" });
  return r.data;
}
