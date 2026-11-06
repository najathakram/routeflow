import { AsyncLocalStorage } from "async_hooks";

/**
 * B1285 / SA-1105 A-3: the NAME of the scheduled job or queue processor that is running, for the dark tenant-context
 * guard's log. It is deliberately its own AsyncLocalStorage and NOT a labelled tenant store: "NONE" means no tenant
 * store at all, and putting one under every job would change what `get()`, `getOrNull()` and `kind()` return there.
 *
 * Producers: `@LeaderCron` (the `<area>.<method>` literal it already holds as its lock key) and the queue processors
 * (`<queue>.<process name>`). Reader: the guard, as `tenantCtx.label() ?? callPlace()`: a route's handler label wins,
 * a job is named by its place. A name is a literal, never an id.
 */
const storage = new AsyncLocalStorage<string>();

/** Runs `fn` with `name` as the call place of everything it awaits. */
export function runAtPlace<T>(name: string, fn: () => T): T {
  return storage.run(name, fn);
}

/** The running job's or processor's name, or undefined outside one. */
export function callPlace(): string | undefined {
  return storage.getStore();
}
