/**
 * SA-1196 A3-2 (SA-1189 K3): the largest empty vertical band inside a scope, whatever the html structure.
 * Content rects are the text (Range.getClientRects over each text node) plus buttons, links styled as buttons,
 * images, inputs and svg. The band is the largest stretch between the first content top and the last content
 * bottom that no content rect covers. One definition, used by the plan rows at every width.
 */
import type { Page } from "@playwright/test";

/** `each`: every shown match is its own scope. `union`: all shown matches together are one scope. */
export type BandScope =
  | { each: string }
  | { union: string; name: string }
  /** `from` and the shown siblings after it, up to and including the first one matching `through`. Nothing before `from`. */
  | { from: string; through: string; name: string };

export interface Band {
  where: string;
  gap: number;
}

export async function emptyBands(page: Page, scope: BandScope): Promise<Band[]> {
  return page.evaluate((spec) => {
    const shown = (el: Element) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const band = (roots: Element[]): number => {
      const rects: { top: number; bottom: number }[] = [];
      const add = (r: { top: number; bottom: number; width: number; height: number }) => {
        if (r.width > 0 && r.height > 0) rects.push({ top: r.top, bottom: r.bottom });
      };
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const parent = n.parentElement;
          if (!parent || !(n.textContent ?? "").trim() || !shown(parent)) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of Array.from(range.getClientRects())) add(r);
        }
        for (const el of Array.from(root.querySelectorAll("button, a.btn, img, input, svg"))) {
          if (shown(el)) add(el.getBoundingClientRect());
        }
      }
      if (rects.length === 0) throw new Error("no content rects in the scope");
      rects.sort((a, b) => a.top - b.top);
      let covered = rects[0]!.bottom;
      let widest = 0;
      for (const r of rects.slice(1)) {
        if (r.top > covered) widest = Math.max(widest, r.top - covered);
        covered = Math.max(covered, r.bottom);
      }
      return widest;
    };
    const label = (el: Element) =>
      (el.querySelector("h2,h3")?.textContent ?? el.getAttribute("aria-label") ?? el.className)
        .toString()
        .trim();
    if ("each" in spec) {
      return Array.from(document.querySelectorAll(spec.each))
        .filter(shown)
        .map((el) => ({ where: label(el), gap: band([el]) }));
    }
    if ("from" in spec) {
      const start = Array.from(document.querySelectorAll(spec.from)).find(shown);
      if (!start) return [];
      const chain: Element[] = [start];
      for (let el = start.nextElementSibling; el; el = el.nextElementSibling) {
        if (!shown(el)) continue;
        chain.push(el);
        if (el.matches(spec.through)) break;
      }
      return [{ where: spec.name, gap: band(chain) }];
    }
    const roots = Array.from(document.querySelectorAll(spec.union)).filter(shown);
    return roots.length ? [{ where: spec.name, gap: band(roots) }] : [];
  }, scope);
}
