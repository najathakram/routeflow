/**
 * W-1187 PR-2b: the order builder's and the counter's lines are a LOCAL list until the sale is sent, and the order they sit
 * in is the order the server stores (it hands out `position` by array index) and the invoice prints. So moving a line is
 * moving it in the array: no request, and one helper for both screens.
 */
export function orderByIds<T>(
  lines: readonly T[],
  ids: readonly string[],
  idOf: (l: T) => string,
): T[] {
  const byId = new Map(lines.map((l) => [idOf(l), l]));
  const placed = new Set<string>();
  const out: T[] = [];
  for (const id of ids) {
    const l = byId.get(id);
    if (l && !placed.has(id)) {
      out.push(l);
      placed.add(id);
    }
  }
  // a line added since the order was recorded keeps its own place after the others
  for (const l of lines) if (!placed.has(idOf(l))) out.push(l);
  return out;
}

/** The list with `id` at `toIndex`; the SAME array when nothing would change. */
export function moveLine<T>(lines: T[], id: string, toIndex: number, idOf: (l: T) => string): T[] {
  const from = lines.findIndex((l) => idOf(l) === id);
  if (from < 0 || toIndex < 0 || toIndex >= lines.length || from === toIndex) return lines;
  const next = lines.slice();
  const [moved] = next.splice(from, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export const movedTitle = (label: string, toIndex: number) =>
  `Moved ${label} to line ${toIndex + 1}`;

/**
 * Puts keyboard focus back on a line's drag handle once the reordered list has rendered (moving a row in the DOM drops
 * focus from the control that held it). The handle carries `data-sortable-handle="<id>"`.
 */
export function focusMoveHandle(id: string) {
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll<HTMLElement>("[data-sortable-handle]")) {
      if (el.dataset.sortableHandle === id) {
        el.focus();
        return;
      }
    }
  });
}
