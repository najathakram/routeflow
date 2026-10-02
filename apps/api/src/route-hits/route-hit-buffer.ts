import { ROUTE_HITS_MAX_KEYS } from "./route-hits.constants";

/**
 * An in-memory, BOUNDED counter between flushes. `record` is a plain Map increment: no await, no I/O. Past
 * `maxKeys` distinct keys a NEW key is dropped and counted in `dropped` (an existing key still increments),
 * so a bug that minted unbounded keys could never grow memory.
 */
export class RouteHitBuffer {
  private counts = new Map<string, number>();
  private droppedCount = 0;

  constructor(private readonly maxKeys: number = ROUTE_HITS_MAX_KEYS) {}

  record(key: string): void {
    const current = this.counts.get(key);
    if (current !== undefined) {
      this.counts.set(key, current + 1);
    } else if (this.counts.size < this.maxKeys) {
      this.counts.set(key, 1);
    } else {
      this.droppedCount += 1;
    }
  }

  /** Takes everything recorded so far and resets the buffer. */
  drain(): { counts: Map<string, number>; dropped: number } {
    const out = { counts: this.counts, dropped: this.droppedCount };
    this.counts = new Map();
    this.droppedCount = 0;
    return out;
  }

  get size(): number {
    return this.counts.size;
  }
}
