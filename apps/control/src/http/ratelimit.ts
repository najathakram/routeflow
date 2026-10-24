/** Login throttle: 5 failures per IP and 30 globally per 15 minutes, all in memory. */
export const WINDOW_MS = 15 * 60_000;
export const PER_IP = 5;
export const GLOBAL = 30;
const MAX_TRACKED_IPS = 5_000;

export interface Limiter {
  blocked(ip: string): boolean;
  fail(ip: string): void;
  /** Undo the most recent `fail` of this IP (a pre-recorded attempt that turned out valid). */
  forgive(ip: string): void;
}

export function createLimiter(opts: { now?: () => number } = {}): Limiter {
  const now = opts.now ?? Date.now;
  const byIp = new Map<string, number[]>();
  let all: number[] = [];
  const fresh = (xs: number[], t: number): number[] => xs.filter((x) => x > t - WINDOW_MS);
  const prune = (t: number): void => {
    all = fresh(all, t);
    if (byIp.size > MAX_TRACKED_IPS / 2) {
      for (const [ip, xs] of byIp) {
        const f = fresh(xs, t);
        if (f.length === 0) byIp.delete(ip);
        else byIp.set(ip, f);
      }
    }
  };
  return {
    blocked(ip) {
      const t = now();
      prune(t);
      return fresh(byIp.get(ip) ?? [], t).length >= PER_IP || all.length >= GLOBAL;
    },
    fail(ip) {
      const t = now();
      prune(t);
      all.push(t);
      if (!byIp.has(ip) && byIp.size >= MAX_TRACKED_IPS) {
        const oldest = byIp.keys().next();
        if (!oldest.done) byIp.delete(oldest.value); // bounded memory under a spoofed-address flood
      }
      byIp.set(ip, [...fresh(byIp.get(ip) ?? [], t), t]);
    },
    forgive(ip) {
      const xs = byIp.get(ip);
      if (!xs || xs.length === 0) return;
      const t = xs[xs.length - 1];
      byIp.set(ip, xs.slice(0, -1));
      const i = all.lastIndexOf(t);
      if (i >= 0) all.splice(i, 1);
    },
  };
}
