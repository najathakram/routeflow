/**
 * B1186 / SA-717: the ONE reader of which constraint a Prisma P2002 (unique violation) names.
 *
 * Two shapes exist. The native engine reports `meta.target` (a field array, or a constraint-name
 * string). The pg DRIVER ADAPTER - what this API runs - leaves `meta.target` UNSET and reports
 * `meta.driverAdapterError.cause.constraint.{index,fields}` (+ the Postgres text in `originalMessage`).
 * A reader that looks only at `meta.target` never fires on the adapter, so a race loser's P2002 escaped
 * as a raw 500. Never read `meta.target` anywhere else (guard: no-direct-meta-target.spec.ts).
 */

export interface UniqueViolationConstraints {
  /** Constraint / index names, original case. */
  names: string[];
  /** Column names, original case (a native `meta.target` array, or the adapter's `constraint.fields`). */
  fields: string[];
}

/** The violated constraint(s), or null when `e` is not a P2002. A P2002 that reports nothing gives empty lists. */
export function uniqueViolationConstraints(e: unknown): UniqueViolationConstraints | null {
  const err = e as { code?: unknown; meta?: Record<string, any> } | null | undefined;
  if (!err || err.code !== "P2002") return null;
  const names: string[] = [];
  const fields: string[] = [];
  const meta = err.meta ?? {};
  if (typeof meta.target === "string") names.push(meta.target);
  else if (Array.isArray(meta.target)) fields.push(...meta.target.map(String));
  const cause = meta.driverAdapterError?.cause;
  const constraint = cause?.constraint;
  if (typeof constraint?.index === "string") names.push(constraint.index);
  if (Array.isArray(constraint?.fields)) fields.push(...constraint.fields.map(String));
  if (typeof cause?.originalMessage === "string") {
    const m = /unique constraint "([^"]+)"/.exec(cause.originalMessage);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return { names, fields };
}

/**
 * True when `e` is a P2002 whose constraint name or one of whose columns contains `needle`
 * (case-insensitive substring), or - with `{ exact: true }` - equals it. An unreported constraint
 * is NEVER a match.
 */
export function uniqueViolationOn(
  e: unknown,
  needle: string,
  opts: { exact?: boolean } = {},
): boolean {
  const c = uniqueViolationConstraints(e);
  if (!c) return false;
  const n = needle.toLowerCase();
  return [...c.names, ...c.fields].some((x) => {
    const h = x.toLowerCase();
    return opts.exact ? h === n : h.includes(n);
  });
}

/** The violated constraint for a log line ("" when none is reported). */
export function describeUniqueViolation(e: unknown): string {
  const c = uniqueViolationConstraints(e);
  if (!c) return "";
  return c.names.length ? c.names.join(",") : c.fields.join(",");
}
