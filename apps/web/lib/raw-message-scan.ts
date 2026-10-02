import * as fs from "fs";
import * as path from "path";

/**
 * B986 scan helper: finds the reads that put a server / axios message into the UI.
 * Used by the static pin `raw-message-scan.test.ts` and by `toast-no-raw-message.test.ts`.
 *
 * Source is MASKED before matching: comments and the contents of '…' / "…" strings are blanked (so a `//` inside a string
 * can never hide a read after it, and prose never counts), regex literals are skipped, and template literals keep their
 * `${…}` expressions (a read inside a template IS a read).
 */

/** Blank comments, string contents and regex literals; keep code and template `${…}` expressions. */
export function maskSource(src: string): string {
  let out = "";
  const n = src.length;
  let i = 0;
  // template nesting: each entry is the brace depth at which the current `${` expression ends
  const tpl: number[] = [];
  let depth = 0;
  let inTemplate = false;
  const prevSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k];
    return "";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (inTemplate) {
      if (c === "\\") {
        out += "  ";
        i += 2;
      } else if (c === "`") {
        inTemplate = false;
        out += " ";
        i++;
      } else if (c === "$" && d === "{") {
        tpl.push(depth);
        depth++;
        inTemplate = false;
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
    } else if (c === "'" || c === '"') {
      // blank the string's contents, except the exact word `message` (so `err["message"]` stays detectable)
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") {
        if (src[k] === "\\") k++;
        k++;
      }
      const body = src.slice(i + 1, k);
      if (body === "message" && src[k] === c) {
        out += src.slice(i, k + 1);
      } else {
        out += " ".repeat(Math.max(0, Math.min(k + 1, n) - i));
      }
      i = Math.min(k + 1, n);
    } else if (c === "`") {
      inTemplate = true;
      out += " ";
      i++;
    } else if (c === "/" && /[(,=:[!&|?{};]|^$/.test(prevSignificant())) {
      // a regex literal: skip to the closing unescaped slash on the same line
      let k = i + 1;
      let cls = false;
      while (k < n && src[k] !== "\n") {
        if (src[k] === "\\") k++;
        else if (src[k] === "[") cls = true;
        else if (src[k] === "]") cls = false;
        else if (src[k] === "/" && !cls) break;
        k++;
      }
      if (k < n && src[k] === "/") {
        for (; i <= k; i++) out += " ";
      } else {
        out += c;
        i++;
      }
    } else {
      if (c === "{") depth++;
      if (c === "}") {
        depth--;
        if (tpl.length > 0 && tpl[tpl.length - 1] === depth) {
          tpl.pop();
          inTemplate = true;
          out += " ";
          i++;
          continue;
        }
      }
      out += c;
      i++;
    }
  }
  return out;
}

/** Receivers that carry a server / axios body or error in this codebase. */
const RECEIVER =
  "(?:err|error|e|ex|exc|data|body|payload|res|resp|response|result|d|errData|errBody|errorBody)";

const READ_FORMS: RegExp[] = [
  // response.data.message / .error / .detail (any depth of optional chaining)
  /\bresponse\??\.data\??\.(?:message|error|detail)\b/g,
  // <alias>.message and <alias>?.message
  new RegExp(`\\b${RECEIVER}\\??\\.message\\b`, "g"),
  // a cast or parenthesised receiver: (err as Error).message, (e as any)?.message, ((x) as {…}).message
  /\)\??\.message\b/g,
  // bracket access: err["message"], data?.["message"]
  /\??\.?\[\s*(?:"|')message(?:"|')\s*\]/g,
  // destructuring: const { message } = err / { data: { message } } = e.response / ({ message: m } = body)
  new RegExp(`\\{[^{}]*\\bmessage\\b[^{}]*\\}\\s*=\\s*[\\w.?\\[\\]"']*${RECEIVER}\\b`, "g"),
  new RegExp(
    `\\{[^{}]*\\{[^{}]*\\bmessage\\b[^{}]*\\}[^{}]*\\}\\s*=\\s*[\\w.?\\[\\]"']*${RECEIVER}\\b`,
    "g",
  ),
];

/** Every raw message read in `src`, in order of position (comments and string contents excluded). */
export function rawMessageReads(src: string): string[] {
  const masked = maskSource(src);
  const hits: Array<{ at: number; text: string; end: number }> = [];
  for (const re of READ_FORMS) {
    re.lastIndex = 0;
    for (const m of masked.matchAll(re))
      hits.push({ at: m.index ?? 0, text: m[0], end: (m.index ?? 0) + m[0].length });
  }
  hits.sort((a, b) => a.at - b.at);
  // a read matched by two forms counts ONCE (overlapping spans)
  const out: string[] = [];
  let until = -1;
  for (const h of hits) {
    if (h.at < until) continue;
    out.push(h.text);
    until = h.end;
  }
  return out;
}

const SKIP_DIRS = new Set(["node_modules", ".next", "e2e", "coverage", ".turbo", "dist"]);

/** Non-test .ts/.tsx source files under `dir`, skipping build output and this scanner itself. */
export function walkSources(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkSources(path.join(dir, ent.name), out);
    } else if (
      /\.(ts|tsx)$/.test(ent.name) &&
      !/\.(test|spec)\.(ts|tsx)$/.test(ent.name) &&
      ent.name !== "raw-message-scan.ts"
    ) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

/** The WALKER: raw read count per file (posix path relative to `root`), for every file with at least one. */
export function scanTree(root: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const f of walkSources(root)) {
    const n = rawMessageReads(fs.readFileSync(f, "utf8")).length;
    if (n > 0) found[path.relative(root, f).split(path.sep).join("/")] = n;
  }
  return found;
}
