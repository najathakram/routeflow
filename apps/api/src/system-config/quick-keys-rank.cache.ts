import { Injectable } from "@nestjs/common";
import { QUICK_KEYS_RANK_TTL_MS } from "./quick-keys-settings";

interface Entry {
  ids: string[];
  windowDays: number;
  expiresAt: number;
}

/** A tenant/register pair is a few dozen bytes; this bound only stops a runaway key space. */
const MAX_ENTRIES = 1000;
const SEP = "\u0000";

/**
 * In-process cache of the quick keys RANKING (SA-747): product ids ordered best seller first, keyed
 * (tenantId, register), alive one hour. Only the ranking is cached; pins, hides and the cap are read live
 * from the settings on every request. A quickKeys PATCH calls `invalidateTenant`.
 *
 * In-process on purpose (no Redis cache service is the house pattern for a derived ranking): another API
 * replica serves its own copy until it expires, at worst an hour of a slightly older ranking. The entry also
 * remembers the look-back window it was built for, so a changed window can never be answered from it.
 * `clock` is a public field so a spec can move time.
 */
@Injectable()
export class QuickKeysRankCache {
  clock: () => number = () => Date.now();
  private readonly entries = new Map<string, Entry>();

  private key(tenantId: string, register: string): string {
    return `${tenantId}${SEP}${register}`;
  }

  get(tenantId: string, register: string, windowDays: number): string[] | undefined {
    const k = this.key(tenantId, register);
    const hit = this.entries.get(k);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.clock() || hit.windowDays !== windowDays) {
      this.entries.delete(k);
      return undefined;
    }
    return [...hit.ids];
  }

  set(tenantId: string, register: string, windowDays: number, ids: string[]): void {
    const k = this.key(tenantId, register);
    this.entries.delete(k); // re-inserting moves it to the newest end of the map
    this.entries.set(k, {
      ids: [...ids],
      windowDays,
      expiresAt: this.clock() + QUICK_KEYS_RANK_TTL_MS,
    });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  invalidateTenant(tenantId: string): void {
    const prefix = `${tenantId}${SEP}`;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  size(): number {
    return this.entries.size;
  }
}
