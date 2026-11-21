// One CSS reader for the site's static tests (SA-1203 A20 R1). It is built on postcss, so strings,
// comments and nesting are the parser's business and nothing is split by hand. It fails closed: an at-rule
// it does not know, or a style rule nested in a style rule, is a problem to report, never silently dropped.
import postcss, {
  type AtRule,
  type ChildNode,
  type Declaration,
  type Root,
  type Rule,
} from "postcss";

/** The at-rules this reader knows (SA-1203 A20 R2). Its length is pinned by a test. */
export const KNOWN_AT_RULES = [
  "media", // walked into; part of the key
  "supports", // walked into; part of the key
  "keyframes", // walked into; keyed `@keyframes <name> :: <frame>`
  "font-face", // read for colour as one rule
  "charset", // allowed, has no body
] as const;

export type CssDecl = {
  source: string;
  line: number;
  /** The chain of at-rule heads the declaration sits in, joined with " > " ("" at the top level). */
  at: string;
  selectors: string[];
  prop: string;
  value: string;
  important: boolean;
};

/** One rule body: the declarations that share one selector list and one at-rule chain. A property that
 *  repeats inside one rule starts a new body, so no value is hidden by a later one. */
export type CssRule = {
  source: string;
  line: number;
  at: string;
  selectors: string[];
  decls: Record<string, string>;
};

export type CssRead = { decls: CssDecl[]; rules: CssRule[]; problems: string[] };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** The index of the first backslash outside a string and a comment, or -1. A backslash inside a quoted string is
 *  ordinary text, as in a content string; anywhere else it starts a CSS escape the matchers cannot see. */
export function escapeOutsideString(text: string): number {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "\\") return i;
  }
  return -1;
}

/** Read one stylesheet text. `lineOffset` is added to every line (for a <style> block inside a page). */
export function readCss(css: string, source: string, lineOffset = 0): CssRead {
  const out: CssRead = { decls: [], rules: [], problems: [] };
  let root: Root;
  try {
    root = postcss.parse(css, { from: undefined });
  } catch (e) {
    const err = e as { line?: number; reason?: string };
    out.problems.push(
      `css syntax error at ${source}:${(err.line ?? 0) + lineOffset} (${err.reason})`,
    );
    return out;
  }
  const lineOf = (n: ChildNode) => (n.source?.start?.line ?? 0) + lineOffset;
  // M1 (SA-1203 A24): an escape outside a string is not decoded, so it is a problem, never a silent pass.
  const checkEscape = (text: string, n: ChildNode) => {
    const at = escapeOutsideString(text);
    if (at < 0) return;
    const where = `${source}:${lineOf(n)}:${n.source?.start?.column ?? 0}`;
    const found = text.slice(Math.max(0, at - 6), at + 8);
    out.problems.push(
      `${where}  form=css-escape  found=${found}  rule=escape-outside-string  Fix: stop, raise with the lead; on approval pin file + form + ruling id.`,
    );
  };

  const addRule = (rule: Rule, chain: string[], selectors: string[]) => {
    const at = chain.join(" > ");
    checkEscape(rule.selector, rule);
    let body: CssRule | null = null;
    for (const child of rule.nodes ?? []) {
      if (child.type === "decl") {
        const d = child as Declaration;
        checkEscape(d.prop, d);
        checkEscape(d.value, d);
        out.decls.push({
          source,
          line: lineOf(d),
          at,
          selectors,
          prop: d.prop,
          value: d.value,
          important: d.important === true,
        });
        if (!body || d.prop in body.decls)
          out.rules.push((body = { source, line: lineOf(rule), at, selectors, decls: {} }));
        body.decls[d.prop] = d.value;
      } else if (child.type === "rule" || child.type === "atrule") {
        out.problems.push(`nested rule at ${source}:${lineOf(child)}`);
      }
    }
  };

  const walk = (nodes: ChildNode[], chain: string[]) => {
    for (const node of nodes) {
      if (node.type === "rule") {
        addRule(node, chain, node.selectors.map(squash));
      } else if (node.type === "atrule") {
        const at = node as AtRule;
        const name = at.name.toLowerCase();
        checkEscape(at.params, at);
        if (!(KNOWN_AT_RULES as readonly string[]).includes(name)) {
          out.problems.push(`unknown at-rule @${at.name} at ${source}:${lineOf(at)}`);
        } else if (name === "media" || name === "supports") {
          walk(at.nodes ?? [], [...chain, `@${name} ${squash(at.params)}`]);
        } else if (name === "keyframes") {
          const head = `@keyframes ${squash(at.params)}`;
          for (const frame of at.nodes ?? [])
            if (frame.type === "rule")
              addRule(frame, [...chain, head], frame.selectors.map(squash));
        } else if (name === "font-face") {
          const asRule = postcss.rule({ selector: "@font-face" });
          asRule.source = at.source;
          for (const c of at.nodes ?? []) asRule.append(c.clone());
          addRule(asRule, chain, ["@font-face"]);
        }
      }
    }
  };
  walk(root.nodes ?? [], []);
  return out;
}

/** Read a style="" attribute as one rule whose selector is `style`. */
export function readStyleAttr(style: string, source: string, lineOffset = 0): CssRead {
  const r = readCss(`style{${style}}`, source, lineOffset);
  return r;
}
