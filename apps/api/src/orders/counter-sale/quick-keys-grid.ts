import { QUICK_KEYS_MAX_CAP } from "../../system-config/quick-keys-settings";

export interface GridSlot {
  id: string;
  pinned: boolean;
}

/**
 * The grid's order and size (SA-747), pure: the pinned products in pin order (only those still LIVE: active
 * and in this tenant, so a gone product never takes a slot), then the ranking minus hidden minus pinned,
 * up to `cap` (clamped to 1..QUICK_KEYS_MAX_CAP). A pin wins over a hide of the same product, because the
 * operator pinned it on purpose. `liveIds` is the set the one product read returned.
 */
export function composeGridIds(input: {
  pinned: readonly string[];
  hidden: readonly string[];
  ranked: readonly string[];
  cap: number;
  liveIds: ReadonlySet<string>;
}): GridSlot[] {
  const cap = Math.min(Math.max(1, Math.trunc(input.cap) || 1), QUICK_KEYS_MAX_CAP);
  const out: GridSlot[] = [];
  const taken = new Set<string>();
  const pinnedAll = new Set(input.pinned);
  for (const id of input.pinned) {
    if (out.length >= cap) break;
    if (taken.has(id) || !input.liveIds.has(id)) continue;
    taken.add(id);
    out.push({ id, pinned: true });
  }
  const hidden = new Set(input.hidden);
  for (const id of input.ranked) {
    if (out.length >= cap) break;
    if (taken.has(id) || pinnedAll.has(id) || hidden.has(id) || !input.liveIds.has(id)) continue;
    taken.add(id);
    out.push({ id, pinned: false });
  }
  return out;
}
