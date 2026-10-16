import { balancedGeneric, callBlocks, WRITE_METHODS } from "./tripwire-scan";

/**
 * B1 (SA R1 / R2): the block-level scanner behind `variant-name-writers-census.spec.ts`. Pure text functions; no fs.
 *
 * A "write block" is ONE statement that can store a product's `name` / `variantName`:
 *   - a Prisma `.product.create | update | upsert | createMany | updateMany` call whose data literal names the key
 *     (or whose data is a variable / spread, which can carry it), or
 *   - a raw SQL `UPDATE "Product" ... SET ... name` / `INSERT INTO "Product" (... name ...)` statement
 *     (`$executeRaw`, `$queryRaw*`, a pg client `.query(`, or a plain template string: the scan is on the SQL text).
 * Each block also records the enclosing function and whether the ONE normaliser (`product-variant-name.ts`) is called
 * earlier in that function, so a census can pin "this many name writes, this many through the normaliser" per file.
 */
export const NORMALISER_CALL =
  /\b(?:stripParentPrefix|bareVariantLabel|bareVariantNames|bareRowNames)\s*\(/g;

export interface NameWriteBlock {
  kind: "prisma" | "raw";
  /** create | update | upsert | createMany | updateMany for Prisma; UPDATE | INSERT for raw SQL. */
  op: string;
  /** Name of the enclosing function / method ("(module)" at top level). */
  fn: string;
  /** The normaliser is called earlier in the enclosing function. */
  normalised: boolean;
  /** Why it counts: the literal names the column, spreads a value, or its data is a variable. */
  why: "key" | "spread" | "opaque" | "sql";
  /** The data literal(s) the call writes ("" when opaque or raw SQL), for a census that asserts what a block never names. */
  data: string;
}

const KEY = /(?:^|[{,\s])(?:name|variantName|"name"|"variantName"|'name'|'variantName')\s*[:,}]/;
const NOT_FN = new Set(["if", "for", "while", "switch", "catch", "return", "else", "await", "do"]);

/** Strip block and line comments (keeps `://`). */
export const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Index of the start of the function that encloses `idx`, and its name. */
function enclosingFn(text: string, idx: number): { start: number; name: string } {
  const head = text.slice(0, idx);
  const re =
    /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^ {2}(?:(?:private|public|protected|static|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\([^;\n]*$|^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm;
  let last: { start: number; name: string } = { start: 0, name: "(module)" };
  for (let m = re.exec(head); m; m = re.exec(head)) {
    const name = m[1] ?? m[2] ?? m[3];
    if (NOT_FN.has(name)) continue;
    last = { start: m.index, name };
  }
  return last;
}

function normalisedBefore(text: string, idx: number): { fn: string; normalised: boolean } {
  const { start, name } = enclosingFn(text, idx);
  return { fn: name, normalised: new RegExp(NORMALISER_CALL.source).test(text.slice(start, idx)) };
}

/** The `data: {...}` / upsert `create: {...}` / `update: {...}` literals of a block, or null when data is not a literal. */
function dataLiterals(block: string, method: string): string[] | null {
  const keys = method === "upsert" ? ["create", "update"] : ["data"];
  const out: string[] = [];
  for (const key of keys) {
    const at = block.search(new RegExp(`\\b${key}\\s*:\\s*[\\[{]`));
    // No literal for the key: `data: variable`, `data,` shorthand, `data: cond ? {..} : {..}`, or no such key at all
    // (`update(buildPatch(dto))`, `create(args)`, an upsert missing its create / update): opaque, it can carry a name.
    if (at === -1) return null;
    const open = block.slice(at).match(/[[{]/)![0];
    out.push(balancedGeneric(block, block.indexOf(open, at), open, open === "{" ? "}" : "]"));
  }
  return out;
}

// `...dto`, `...rest` and `...(dto as Input)` carry keys the scan cannot see (a parenthesised spread is a spread too).
const SPREAD = /\.\.\.\s*[(A-Za-z_$]/;

export function prismaNameWrites(text: string): NameWriteBlock[] {
  const out: Array<NameWriteBlock & { at: number }> = [];
  for (const method of WRITE_METHODS) {
    const needle = `.product.${method}(`;
    for (let from = text.indexOf(needle); from !== -1; from = text.indexOf(needle, from + 1)) {
      const block = callBlocks(text.slice(from), "product", [method])[0] ?? "";
      const lits = dataLiterals(block, method);
      const why =
        lits === null
          ? "opaque"
          : lits.some((l) => KEY.test(l))
            ? "key"
            : lits.some((l) => SPREAD.test(l))
              ? "spread"
              : null;
      if (!why) continue;
      out.push({
        kind: "prisma",
        op: method,
        why,
        data: (lits ?? []).join("\n"),
        at: from,
        ...normalisedBefore(text, from),
      });
    }
  }
  // source order, so a pin and its failure message read top to bottom
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...block }) => block);
}

export function rawSqlNameWrites(text: string): NameWriteBlock[] {
  const out: NameWriteBlock[] = [];
  const upd = /\bUPDATE\s+(?:"?[A-Za-z_]\w*"?\.)?"?Product"?\s+(?:AS\s+\w+\s+)?SET\b([^`;]*)/gi;
  for (let m = upd.exec(text); m; m = upd.exec(text)) {
    // the SET list runs to WHERE / FROM / RETURNING; a quoted or bare name / variantName column on its left side
    const set = m[1].split(/\bWHERE\b|\bFROM\b|\bRETURNING\b/i)[0];
    if (/(?:^|[,\s(])"?(?:name|variantName)"?\s*=/i.test(set)) {
      out.push({
        kind: "raw",
        op: "UPDATE",
        why: "sql",
        data: "",
        ...normalisedBefore(text, m.index),
      });
    }
  }
  const ins = /\bINSERT\s+INTO\s+(?:"?[A-Za-z_]\w*"?\.)?"?Product"?\s*\(([^)]*)\)/gi;
  for (let m = ins.exec(text); m; m = ins.exec(text)) {
    if (/(?:^|[,\s])"?(?:name|variantName)"?\s*(?:,|$)/i.test(m[1])) {
      out.push({
        kind: "raw",
        op: "INSERT",
        why: "sql",
        data: "",
        ...normalisedBefore(text, m.index),
      });
    }
  }
  return out;
}

export function nameWrites(commentFreeText: string): NameWriteBlock[] {
  return [...prismaNameWrites(commentFreeText), ...rawSqlNameWrites(commentFreeText)];
}

/** `fn:op` -> count, e.g. { "create:prisma": 1 }, plus how many of each went through the normaliser. */
export function summarise(blocks: NameWriteBlock[]): {
  blocks: number;
  normalised: number;
  byFn: Record<string, number>;
} {
  const byFn: Record<string, number> = {};
  for (const b of blocks) {
    const k = `${b.fn}:${b.kind === "raw" ? "sql-" : ""}${b.op}${b.normalised ? "+" : ""}`;
    byFn[k] = (byFn[k] ?? 0) + 1;
  }
  return { blocks: blocks.length, normalised: blocks.filter((b) => b.normalised).length, byFn };
}
