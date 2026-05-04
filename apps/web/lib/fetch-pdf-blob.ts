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
 * returned 401. The new rule:
 *
 *   - Same-origin as our API base URL → route through the auth'd client (it
 *     auto-attaches the Bearer token via interceptor; absolute URLs are
 *     respected by axios and bypass baseURL prepending).
 *   - Different origin (R2 / S3 presigned) → bare axios, no auth header.
 *   - Relative path (legacy callers) → auth'd client.
 */
import type { AxiosInstance } from "axios";
import axios from "axios";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000/api/v1";

let API_ORIGIN: string | null = null;
try {
  API_ORIGIN = new URL(API_BASE_URL).origin;
} catch {
  API_ORIGIN = null;
}

export async function fetchPdfBlob(
  url: string,
  authClient: AxiosInstance,
): Promise<Blob> {
  const isAbsolute = /^https?:\/\//i.test(url);
  let urlOrigin: string | null = null;
  if (isAbsolute) {
    try {
      urlOrigin = new URL(url).origin;
    } catch {
      urlOrigin = null;
    }
  }
  const isOurApi = !isAbsolute || (urlOrigin !== null && urlOrigin === API_ORIGIN);

  if (isOurApi) {
    const r = await authClient.get<Blob>(url, { responseType: "blob" });
    return r.data;
  }
  const r = await axios.get<Blob>(url, { responseType: "blob" });
  return r.data;
}
