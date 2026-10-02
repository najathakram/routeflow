/**
 * Pinned clock for control-system tests. The implementation reads `CONTROL_NOW` (ISO UTC) wherever
 * it needs "now"; tests pin it here so every derived value is reproducible.
 */
export const NOW = "2026-01-12T10:00:00Z";

/** Pin `CONTROL_NOW`; returns a restore function for `afterEach`/`afterAll`. */
export function pinClock(iso: string = NOW): () => void {
  const prev = process.env.CONTROL_NOW;
  process.env.CONTROL_NOW = iso;
  return () => {
    if (prev === undefined) delete process.env.CONTROL_NOW;
    else process.env.CONTROL_NOW = prev;
  };
}
