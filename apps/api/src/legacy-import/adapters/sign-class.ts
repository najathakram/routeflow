// SA-1295 A1 C6 Rule 3: on a file with no transaction-type column, the fallback sourceKey carries
// the SIGN CLASS of the document, never an inferred kind. A later linked load can then refine the
// kind (NEGATIVE_UNKNOWN -> CREDIT_MEMO) without re-keying. A key never changes once written.

export type SignClass = "untyped+" | "untyped-";

/** `net` is the document's net of the file's totals; null (no totals) and zero class as untyped+. */
export function signClassOf(net: number | null): SignClass {
  return net !== null && net < 0 ? "untyped-" : "untyped+";
}

export function buildFallbackSourceKey(signClass: SignClass, docNumber: string): string {
  return `${signClass}:${docNumber.trim()}`;
}
