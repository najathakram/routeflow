// One definition of an illustration figure, shared by the copy-rule test (T10) and the copper test (T17),
// so the two cannot drift (SA-1203 A3 1a, A4 G4). An illustration is a <figure> whose own role attribute is
// exactly "img" and whose own aria-label attribute has non-empty trimmed text. A data-role or data-aria-label
// attribute does not count, and neither does a label of spaces.

/** The value of the attribute `name` in a tag's attribute text, or null. Exact name, not a suffix. */
export function attrValue(attrs: string, name: string): string | null {
  const m = new RegExp("(?:^|\\s)" + name + '="([^"]*)"').exec(attrs);
  return m ? m[1] : null;
}

/** For the tokenizer: is a tag with this name and attribute text an illustration figure? */
export function isIllustrationTag(tag: string, attrs: string): boolean {
  return (
    tag.toLowerCase() === "figure" &&
    attrValue(attrs, "role") === "img" &&
    (attrValue(attrs, "aria-label") ?? "").trim() !== ""
  );
}

/** For the DOM: is this element an illustration figure? */
export function isIllustrationElement(el: Element): boolean {
  return (
    el.tagName.toLowerCase() === "figure" &&
    el.getAttribute("role") === "img" &&
    (el.getAttribute("aria-label") ?? "").trim() !== ""
  );
}

/** The nearest illustration figure that contains the element (or is it), or null. */
export function closestIllustration(el: Element): Element | null {
  for (let e: Element | null = el; e; e = e.parentElement) if (isIllustrationElement(e)) return e;
  return null;
}
