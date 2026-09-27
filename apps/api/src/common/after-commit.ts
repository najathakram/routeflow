/**
 * #2175 (SA-487, option A): realtime emits leave a transaction only AFTER it commits.
 *
 * A gateway emit is fire-and-forget. Fired inside `tenantTransaction(...)`, it told operators and
 * buyers about a change that a later rollback undid. The rule here: the tx body (and any InTx
 * helper it calls, which takes the caller's queue as a parameter) QUEUES its emits; the METHOD that
 * owns the transaction flushes them once the awaited transaction has resolved. A rejected
 * transaction flushes nothing. Payloads may be built from tx data inside; they are SENT after.
 *
 * `after.defer(this.gateway).emitX(...)` is the usual form: the same call, queued as a closure.
 * The queue resets on every attempt of the callback, so a retried attempt never re-sends the emits
 * of one that rolled back (SA-487's retryOnTxConflict hazard).
 */
import { Logger } from "@nestjs/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any gateway-shaped object
type AnyFn = (...args: any[]) => unknown;
/** `target`'s methods, returning void: each call is queued instead of made. */
export type Deferred<G> = {
  [K in keyof G]: G[K] extends AnyFn ? (...args: Parameters<G[K]>) => void : never;
};

const logger = new Logger("AfterCommit");

export class AfterCommit {
  private queue: Array<() => void> = [];

  /** Queue one closure to run after the owning transaction commits. */
  push(fn: () => void): void {
    this.queue.push(fn);
  }

  /** A stand-in for `target` (the gateway): every method call is queued, not made. */
  defer<G extends object>(target: G): Deferred<G> {
    return new Proxy({} as Deferred<G>, {
      get: (_t, key) => {
        const method = (target as Record<string | symbol, unknown>)[key];
        if (typeof method !== "function") return undefined;
        return (...args: unknown[]) => this.push(() => (method as AnyFn).apply(target, args));
      },
    });
  }

  /** Drop everything queued (a new attempt of the transaction callback starts clean). */
  reset(): void {
    this.queue = [];
  }

  /** Run the queue once. An emit that throws is logged; it never fails the committed write. */
  flush(): void {
    const queued = this.queue;
    this.queue = [];
    for (const fn of queued) {
      try {
        fn();
      } catch (err) {
        logger.error(`post-commit emit failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  }
}

/**
 * `prisma.tenantTransaction(body)`, with an AfterCommit queue handed to the body and flushed only
 * once the transaction has committed (a rejection propagates and flushes nothing).
 */
export async function withAfterCommit<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tenant tx client is `any` upstream
  prisma: { tenantTransaction<R>(fn: (tx: any) => Promise<R>): Promise<R> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: (tx: any, after: AfterCommit) => Promise<T>,
): Promise<T> {
  const after = new AfterCommit();
  const result = await prisma.tenantTransaction((tx) => {
    after.reset();
    return body(tx, after);
  });
  after.flush();
  return result;
}

/**
 * For an InTx helper that may run inside a CALLER's transaction: outside one, `gateway` itself;
 * inside one, the caller's queue (required, so an emit can never fire inside a transaction it
 * does not own).
 */
export function gatewayFor<G extends object>(
  tx: unknown,
  after: AfterCommit | undefined,
  gateway: G,
  site: string,
): G | Deferred<G> {
  if (!tx) return gateway;
  if (!after)
    throw new Error(`${site}: a caller-owned transaction must pass its AfterCommit queue (#2175)`);
  return after.defer(gateway);
}
