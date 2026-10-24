/** K11 lane L2 group A: the base URL of the stack under test. Throws when unset, never falls back to a default URL. */
export function k11BaseUrl(): string {
  const url = process.env.PLAYWRIGHT_BASE_URL;
  if (!url) {
    throw new Error(
      "PLAYWRIGHT_BASE_URL is not set. Point it at the local compose stack (for example the web service from `npm run local:up`).",
    );
  }
  return url;
}
