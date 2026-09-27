/**
 * THE unit-label normaliser (SA-408b): every unit-label compare goes through it (trim + lowercase),
 * so "case", " Case" and "CASE" are one unit. Pure and import-free on purpose: the Nest-free
 * selling-restrictions module (order-edit-lines.ts) and the Nest-aware products/line-units.ts both
 * import it, and neither may drag the other's dependencies along.
 */
export const norm = (s: string): string => s.trim().toLowerCase();
