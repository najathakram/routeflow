/**
 * The site host as printed on a document: an origin's host (and port) without a leading `www.`.
 * Pure and import-free, so a test that mocks `common/brand` still gets the real function.
 */
export function brandHost(origin: string): string {
  return new URL(origin).host.replace(/^www\./, "");
}
