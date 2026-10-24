/**
 * Test double for `withAdvisoryLock` (same contract: `fn` never runs without the lock; the same
 * key serialises, different keys do not). A spec installs it with
 *
 *   jest.mock("../common/db-locks", () => ({
 *     ...jest.requireActual("../common/db-locks"),
 *     withAdvisoryLock: jest.requireActual("./testing/lock-mock").fakeWithAdvisoryLock,
 *   }));
 *
 * and reads `lockState` to assert WHICH family/key was locked and in what order relative to the
 * world's own event log (`lockState.events`).
 */
export interface LockCall {
  family: string;
  key: string;
  mode: string;
  waitMs?: number;
}

export const lockState: {
  calls: LockCall[];
  events: string[];
  failWith: Error | null;
  held: Set<string>;
  tails: Map<string, Promise<unknown>>;
} = { calls: [], events: [], failWith: null, held: new Set(), tails: new Map() };

export function resetLockState(): void {
  lockState.calls = [];
  lockState.events = [];
  lockState.failWith = null;
  lockState.held = new Set();
  lockState.tails = new Map();
}

export async function fakeWithAdvisoryLock<T>(
  opts: LockCall,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T }> {
  lockState.calls.push({
    family: opts.family,
    key: opts.key,
    mode: opts.mode,
    waitMs: opts.waitMs,
  });
  if (lockState.failWith) throw lockState.failWith;
  const id = `${opts.family}:${opts.key}`;
  const prev = lockState.tails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  lockState.tails.set(
    id,
    prev.then(() => mine),
  );
  await prev;
  lockState.held.add(id);
  lockState.events.push(`lock:acquire:${id}`);
  try {
    return { acquired: true, value: await fn() };
  } finally {
    lockState.events.push(`lock:release:${id}`);
    lockState.held.delete(id);
    release();
  }
}
