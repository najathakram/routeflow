/**
 * Parity capture for test T12 (R12: nothing is lost). Used by spec 85.
 *
 * captureParity() lists, for one loaded public page at one window size, everything a visitor or the
 * keyboard can reach: every link (href + text), button (name), form control, id target, accordion,
 * and the 15 wheel tile buttons. The baseline (site-parity.baseline.json) is written ONCE from master's
 * build with SITE_PARITY_WRITE=1; afterwards the spec compares a fresh capture against it, minus the
 * rows listed in site-parity.changes.json (each names the requirement, R#, that allows the change).
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The two size classes captured: the wide layout and the phone layout (they carry different menus). */
export const PARITY_SIZES = [
  { cls: "desktop", w: 1440, h: 900 },
  { cls: "phone", w: 390, h: 844 },
] as const;

export const PARITY_BASELINE_PATH = path.join(__dirname, "site-parity.baseline.json");
export const PARITY_CHANGES_PATH = path.join(__dirname, "site-parity.changes.json");

/** key "<route>|<size class>" -> sorted, unique rows. */
export type ParityMap = Record<string, string[]>;
export type ParityFile = { version: 1; pages: ParityMap };
export type ParityChange = {
  key: string;
  row: string;
  kind: "added" | "removed";
  /** The requirement that allows this change, e.g. "R22". */
  req: string;
};

export const parityKey = (route: string, cls: string): string => `${route}|${cls}`;

export type ParityBrand = { name: string; formerly: string };

/** The whole-word pattern of scripts/lib/site-port-tokens.cjs:29-32, built with its escapeRe (:7). */
export function brandPatternSource(value: string): string {
  const { escapeRe } = require("../../../../scripts/lib/site-port-tokens.cjs") as {
    escapeRe: (text: string) => string;
  };
  return `(?<![\\w.@/])${escapeRe(value)}(?!\\w|\\.\\w)`;
}

/**
 * The name becomes {{brand:name}}; the previous name, only when it differs, becomes
 * {{brand:formerly}}. A page that still shows the previous name then differs from the baseline.
 */
export function normaliseBrand(text: string, brand: ParityBrand): string {
  let out = text.replace(new RegExp(brandPatternSource(brand.name), "g"), "{{brand:name}}");
  if (brand.formerly !== brand.name) {
    out = out.replace(new RegExp(brandPatternSource(brand.formerly), "g"), "{{brand:formerly}}");
  }
  return out;
}

/** Collapse whitespace, normalise the names, then cut at 100 (the cut no longer depends on the name). */
export function normaliseRow(raw: string, brand: ParityBrand): string {
  return normaliseBrand(raw.replace(/\s+/g, " ").trim(), brand).trim().slice(0, 100);
}

/** The brand as the file holds it now; never typed here. */
function readBrand(): ParityBrand {
  const file = path.join(__dirname, "../../../../packages/types/brand/brand.json");
  return parseBrand(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ParityBrand>);
}

/** An empty name would make an empty pattern that matches everywhere: refuse it. */
export function parseBrand(b: Partial<ParityBrand>): ParityBrand {
  for (const key of ["name", "formerly"] as const) {
    if (typeof b[key] !== "string" || b[key] === "") {
      throw new Error(`brand.json: "${key}" must be a non-empty string`);
    }
  }
  return { name: b.name as string, formerly: b.formerly as string };
}

/** Everything reachable on the page now. Runs inside the browser. */
export async function captureParity(page: import("@playwright/test").Page): Promise<string[]> {
  const brand = readBrand();
  const pats = {
    name: brandPatternSource(brand.name),
    formerly: brand.formerly !== brand.name ? brandPatternSource(brand.formerly) : "",
  };
  return page.evaluate((p) => {
    // Mirrors normaliseRow above: collapse, then the tokens, then the cut at 100.
    const norm = (s: string | null | undefined) => {
      let t = (s || "").replace(/\s+/g, " ").trim();
      t = t.replace(new RegExp(p.name, "g"), "{{brand:name}}");
      if (p.formerly) t = t.replace(new RegExp(p.formerly, "g"), "{{brand:formerly}}");
      return t.trim().slice(0, 100);
    };
    const rows = new Set<string>();
    const labelOf = (el: Element) =>
      norm(el.getAttribute("aria-label")) ||
      norm(el.textContent) ||
      norm(el.querySelector("img")?.getAttribute("alt")) ||
      norm(el.getAttribute("title"));
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      rows.add(`a|${a.getAttribute("href")}|${labelOf(a)}`);
    }
    for (const b of Array.from(document.querySelectorAll("button:not(.rfw-b), [role=button]"))) {
      rows.add(`button|${labelOf(b)}`);
    }
    for (const b of Array.from(document.querySelectorAll("button.rfw-b"))) {
      const label = norm(b.getAttribute("aria-label"));
      rows.add(`tile|${b.getAttribute("data-i")}|${label.split(":")[0]}`);
    }
    for (const c of Array.from(document.querySelectorAll("input, select, textarea"))) {
      const id = c.getAttribute("id");
      const lab = id
        ? norm(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent)
        : "";
      rows.add(
        `control|${c.tagName.toLowerCase()}|${c.getAttribute("type") || ""}|${c.getAttribute("name") || id || ""}|${lab || norm(c.getAttribute("aria-label")) || norm(c.getAttribute("placeholder"))}`,
      );
    }
    for (const el of Array.from(document.querySelectorAll("[id]"))) {
      const id = el.getAttribute("id") || "";
      if (!id || /^(:|radix-|headlessui-|__next)/.test(id)) continue;
      rows.add(`id|${id}`);
    }
    for (const d of Array.from(document.querySelectorAll("details"))) {
      rows.add(`details|${norm(d.querySelector("summary")?.textContent)}`);
    }
    return Array.from(rows).sort();
  }, pats);
}

export function readParityFile(file: string): ParityFile {
  if (!fs.existsSync(file)) {
    throw new Error(
      `${path.basename(file)} is missing. Capture it once from master's build: SITE_PARITY_WRITE=1 ... --project=site-proof -g "T12"`,
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ParityFile;
}

export function readChanges(): ParityChange[] {
  const list = JSON.parse(fs.readFileSync(PARITY_CHANGES_PATH, "utf8")) as ParityChange[];
  for (const c of list) {
    if (!/^R\d+$/.test(c.req) || !c.key || !c.row || (c.kind !== "added" && c.kind !== "removed")) {
      throw new Error(
        `site-parity.changes.json: bad row ${JSON.stringify(c)} (needs key, row, kind, req "R#")`,
      );
    }
  }
  return list;
}

/**
 * Differences between the baseline and a fresh capture that no changes row explains, plus changes
 * rows that explain nothing (a stale allowance would hide a later loss).
 */
export function diffParity(base: ParityMap, now: ParityMap, changes: ParityChange[]): string[] {
  const out: string[] = [];
  const used = new Set<ParityChange>();
  const allowed = (key: string, row: string, kind: "added" | "removed") => {
    const hit = changes.find((c) => c.key === key && c.row === row && c.kind === kind);
    if (hit) used.add(hit);
    return !!hit;
  };
  for (const key of new Set([...Object.keys(base), ...Object.keys(now)])) {
    if (!(key in base)) {
      out.push(`${key}: page was not in the baseline`);
      continue;
    }
    if (!(key in now)) {
      out.push(`${key}: page was not captured`);
      continue;
    }
    const b = new Set(base[key]);
    const n = new Set(now[key]);
    for (const row of b)
      if (!n.has(row) && !allowed(key, row, "removed")) out.push(`${key}: LOST ${row}`);
    for (const row of n)
      if (!b.has(row) && !allowed(key, row, "added")) out.push(`${key}: ADDED ${row}`);
  }
  for (const c of changes)
    if (!used.has(c))
      out.push(`${c.key}: changes row for ${c.kind} "${c.row}" (${c.req}) matches no difference`);
  return out;
}
