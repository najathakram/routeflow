/**
 * #2421: a tiny, dependency-free scanner for UNSCOPED bulk writes in a JS/TS source file, used by
 * scripts-unscoped-delete.spec.ts. Deliberately simple (no parser dependency), but string-aware:
 * comments are only recognised OUTSIDE strings and templates, so `'a//b'` never hides the code that
 * follows it.
 *
 * Flags:
 *   - `.deleteMany(` / `.updateMany(` (whitespace allowed before the paren) whose argument is empty,
 *     `{}`, an object literal with no top-level `where`, or `where: {}`. A non-literal argument (a
 *     variable) cannot be judged statically and is not flagged.
 *   - any string/template literal containing `TRUNCATE`;
 *   - a literal with `DELETE FROM` and no `WHERE`;
 *   - a literal with `UPDATE <table> SET` and no `WHERE`.
 *   Literals concatenated with `+` are judged as one statement (a WHERE in the next piece counts).
 */

type Seg = { kind: "code" | "literal"; text: string };

/** Split source into code and string/template-literal segments, dropping comments (code only). */
export function segments(src: string): Seg[] {
  const out: Seg[] = [];
  let code = "";
  let i = 0;
  const flushCode = () => {
    if (code) out.push({ kind: "code", text: code });
    code = "";
  };
  const readQuoted = (q: string): string => {
    let s = q;
    i++;
    while (i < src.length) {
      const c = src[i];
      s += c;
      i++;
      if (c === "\\") {
        s += src[i] ?? "";
        i++;
      } else if (c === q || (c === "\n" && q !== "`")) break;
    }
    return s;
  };
  const readTemplate = (): string => {
    let s = "`";
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") {
        s += c + (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        s += c;
        i++;
        break;
      }
      if (c === "$" && src[i + 1] === "{") {
        // A hole: copy it (with nested strings/braces) into the literal text as-is.
        let depth = 0;
        do {
          const d = src[i];
          if (d === "{") depth++;
          else if (d === "}") depth--;
          else if (d === "'" || d === '"') {
            s += readQuoted(d);
            continue;
          } else if (d === "`") {
            s += readTemplate();
            continue;
          }
          s += d;
          i++;
        } while (i < src.length && depth > 0);
        continue;
      }
      s += c;
      i++;
    }
    return s;
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      code += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      flushCode();
      out.push({ kind: "literal", text: readQuoted(c) });
      continue;
    }
    if (c === "`") {
      flushCode();
      out.push({ kind: "literal", text: readTemplate() });
      continue;
    }
    code += c;
    i++;
  }
  flushCode();
  return out;
}

/** The source with comments removed and every literal kept in place. */
export function stripComments(src: string): string {
  return segments(src)
    .map((s) => s.text)
    .join("");
}

/** The balanced text between the `(` at `open` and its matching `)`, string-aware. */
function argumentText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** Top-level keys of an object-literal text `{ a: 1, where: {...}, ...x }` (spreads as "..."). */
function topLevelKeys(obj: string): Map<string, string> {
  const keys = new Map<string, string>();
  const body = obj.trim().replace(/^\{/, "").replace(/\}$/, "");
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      i++;
      while (i < body.length && body[i] !== q) {
        if (body[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p.startsWith("...")) {
      keys.set("...", p.slice(3));
      continue;
    }
    const m = /^["']?([A-Za-z_$][\w$]*)["']?\s*(:\s*([\s\S]*))?$/.exec(p);
    if (m) keys.set(m[1], m[3] ?? m[1]);
  }
  return keys;
}

/** Is this bulk-write argument text unscoped (no effective top-level where)? */
export function isUnscopedBulkArg(arg: string): boolean {
  const a = arg.trim();
  if (a === "") return true;
  if (!a.startsWith("{")) return false; // a variable: not judged statically
  const keys = topLevelKeys(a);
  if (keys.has("...")) return false; // a spread may carry the where
  if (!keys.has("where")) return true;
  return /^\{\s*\}$/.test((keys.get("where") ?? "").trim());
}

export interface ScanResult {
  jsCalls: string[];
  rawSql: string[];
}

export function scanUnscopedWrites(src: string): ScanResult {
  const segs = segments(src);
  // Calls are found in CODE only: every literal becomes an empty-string placeholder, so text that
  // merely mentions an empty-argument bulk delete inside a string is never a call, while argument
  // shapes (keys, braces) survive for the where check.
  const code = segs.map((s) => (s.kind === "code" ? s.text : '""')).join("");
  const jsCalls: string[] = [];
  const call = /\.(deleteMany|updateMany)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(code)) !== null) {
    const arg = argumentText(code, m.index + m[0].length - 1);
    if (isUnscopedBulkArg(arg)) jsCalls.push(`${m[1]}(${arg.trim().slice(0, 40)})`);
  }
  // A SQL statement is often split across literals joined with `+`; judge each such run as one.
  const statements: string[] = [];
  let run: string[] = [];
  for (const s of segs) {
    if (s.kind === "literal") run.push(s.text);
    else if (!/^[\s+()]*$/.test(s.text) && run.length) {
      statements.push(run.join(" "));
      run = [];
    }
  }
  if (run.length) statements.push(run.join(" "));
  const rawSql: string[] = [];
  for (const t of statements) {
    const hasWhere = /\bWHERE\b/i.test(t);
    if (/\bTRUNCATE\b/i.test(t)) rawSql.push(`TRUNCATE: ${t.slice(0, 50)}`);
    if (/\bDELETE\s+FROM\b/i.test(t) && !hasWhere) rawSql.push(`DELETE: ${t.slice(0, 50)}`);
    if (/\bUPDATE\s+["\w.]+\s+SET\b/i.test(t) && !hasWhere)
      rawSql.push(`UPDATE: ${t.slice(0, 50)}`);
  }
  return { jsCalls, rawSql };
}
