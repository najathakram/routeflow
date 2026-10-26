import { WRITE_METHODS, balancedGeneric, trackedDelegateWrites } from "../products/tripwire-scan";

/**
 * Row 430 (SA-958 §3.2) writer scanner, shared by the audit pin. Pure text functions. A tracked category is written by
 * a delegate call (`tx.trackedCategory.create(...)`), and the shapes that slip past a plain `.trackedCategory.create(`
 * search are caught here too: bracket access, an alias of the delegate, a destructured delegate, raw SQL, and a nested
 * relation write (`tenant.update({ data: { trackedCategories: { create: ... } } })`).
 */

/** `tx["trackedCategory"]`, `tx?.trackedCategory` and a line-split call are the same delegate call as `tx.trackedCategory.x(`. */
const normaliseBrackets = (text: string): string =>
  text
    .replace(/\[\s*["'`](trackedCategory|trackedSubcategory)["'`]\s*\]/g, ".$1")
    // `tx?.trackedCategory?.create(` and a call split across lines are the same call
    .replace(/\s*\??\.\s*(trackedCategory|trackedSubcategory)\b/g, ".$1")
    .replace(/\b(trackedCategory|trackedSubcategory)\s*\??\.\s*(\w+)\s*\(/g, "$1.$2(");

/** The only things allowed to touch the delegate besides a write: reads. */
const READ_METHODS = [
  "findMany",
  "findFirst",
  "findUnique",
  "findFirstOrThrow",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
];

export type WriterShape = "delegate" | "alias" | "destructured" | "raw-sql" | "nested";

export interface WriterSite {
  shape: WriterShape;
  /** Delegate writes only: which delegate. */
  delegate?: "trackedCategory" | "trackedSubcategory";
  /** The matched source text, for the failure message. */
  text: string;
  /** Index into the NORMALISED text (delegate writes only): where the audit call must follow. */
  at?: number;
  /** The identifier the delegate hangs off (`tx` in `tx.trackedCategory.create`), delegate writes only. */
  receiver?: string;
}

/** Comments say what the code does not do; a `// tx.trackedCategory.create(` in one is not a writer. */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^\s*\/\/.*$/gm, "");

export function trackedCategoryWriterSites(source: string): WriterSite[] {
  const text = stripComments(normaliseBrackets(source));
  const sites: WriterSite[] = [];

  // 1. Delegate writes, every method tripwire-scan knows (createMany, createManyAndReturn, updateManyAndReturn ...) plus the
  // deletes. `trackedDelegateWrites` is the shared counter; the spec pins that this scan sees exactly as many.
  const writes = new RegExp(
    `([A-Za-z_$][\\w$]*|\\))\\s*\\.\\s*(trackedCategory|trackedSubcategory)\\s*\\.\\s*(${[...WRITE_METHODS, "delete", "deleteMany"].join("|")})\\s*\\(`,
    "g",
  );
  for (let m = writes.exec(text); m; m = writes.exec(text)) {
    sites.push({
      shape: "delegate",
      delegate: m[2] as WriterSite["delegate"],
      text: m[0].replace(/\s+/g, " "),
      at: m.index,
      receiver: m[1],
    });
  }

  // 2. The delegate handed around instead of called: `const d = tx.trackedCategory;`, `use(tx.trackedCategory)`. A property
  // read (`.trackedCategory?.name`), a select key (`trackedCategory: {`) and a method call are not aliases.
  const alias =
    /(?:=|\(|,|\breturn)\s*[A-Za-z_$][\w$.?]*\.\s*tracked(?:Sub)?[Cc]ategory\b(?!\s*[.?:\w(])/g;
  for (let m = alias.exec(text); m; m = alias.exec(text)) {
    sites.push({ shape: "alias", text: m[0].replace(/\s+/g, " ").slice(0, 80) });
  }
  // A method that is neither a read nor a write we count (`.trackedCategory.someFutureWrite(`) is unknown: flag it.
  const call = /\.\s*(trackedCategory|trackedSubcategory)\s*\.\s*(\w+)\s*\(/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    if (![...READ_METHODS, ...WRITE_METHODS, "delete", "deleteMany"].includes(m[2])) {
      sites.push({ shape: "alias", text: text.slice(m.index, m.index + 60) });
    }
  }

  // 3. Destructured: `const { trackedCategory } = tx;`
  const destructured = /\{[^{}]*\btracked(?:Sub)?[Cc]ategory\b[^{}]*\}\s*=/g;
  for (let m = destructured.exec(text); m; m = destructured.exec(text)) {
    sites.push({ shape: "destructured", text: m[0].slice(0, 80) });
  }

  // 4. Raw SQL against either table.
  const raw =
    /(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+("?public"?\.)?"?(TrackedCategory|TrackedSubcategory|tracked_categor\w*|tracked_subcategor\w*)"?/gi;
  for (let m = raw.exec(text); m; m = raw.exec(text)) {
    sites.push({ shape: "raw-sql", text: m[0].slice(0, 80) });
  }

  // 5. Nested relation write from a parent: `trackedCategories: { create: ... }`, `subcategories: { createMany: ... }`.
  const nested =
    /\b(trackedCategories|trackedSubcategories|subcategories|trackedCategory|trackedSubcategory)\s*:\s*\{\s*(create|createMany|update|updateMany|upsert|connectOrCreate|delete|deleteMany|set|connect|disconnect)\b/g;
  for (let m = nested.exec(text); m; m = nested.exec(text)) {
    sites.push({ shape: "nested", text: m[0].slice(0, 80) });
  }

  return sites;
}

/** The body of the nearest callback before `at` whose parameter is `receiver` (`async (tx) => { ... }`), or null. */
function callbackBodyOf(text: string, at: number, receiver: string): string | null {
  const head = text.slice(0, at);
  const re = new RegExp(
    `\\(\\s*${receiver.replace(/\$/g, "\\$")}\\b[^)]*\\)\\s*(?::[^=]+)?=>\\s*\\{`,
    "g",
  );
  const opens = [...head.matchAll(re)].map((m) => (m.index ?? 0) + m[0].length - 1);
  for (const open of opens.reverse()) {
    const body = balancedGeneric(text, open, "{", "}");
    if (open + body.length > at) return body; // this callback encloses the write
  }
  return null;
}

/**
 * Is the write at `site` audited ON THE SAME transaction handle, inside the SAME callback? The callback's body must hold
 * at least as many audit calls on that handle as TrackedCategory writes on it, so deleting one write's audit fails even
 * when a neighbouring function's audit sits close by.
 */
export function auditFollowsOnSameTx(source: string, site: WriterSite): boolean {
  if (site.at == null || !site.receiver) return false;
  const text = stripComments(normaliseBrackets(source));
  const body = callbackBodyOf(text, site.at, site.receiver);
  if (body == null) return false;
  const audits = (
    body.match(
      new RegExp(
        `auditTrackedCategoryWrite\\(\\s*${site.receiver.replace(/\$/g, "\\$")}\\s*,`,
        "g",
      ),
    ) ?? []
  ).length;
  const writes = trackedCategoryWriterSites(body).filter(
    (s) =>
      s.shape === "delegate" && s.delegate === "trackedCategory" && s.receiver === site.receiver,
  ).length;
  return audits > 0 && audits >= writes;
}

/** Exposed so the pin's self-test can show the old matcher missed these shapes. */
export const OLD_WRITER_MATCHER =
  /trackedCategory\s*\.\s*(create|update|upsert|delete|updateMany|deleteMany)\s*\(/g;

/** The shared tripwire counter's view of the same source, for the spec's parity check. */
export { trackedDelegateWrites };
