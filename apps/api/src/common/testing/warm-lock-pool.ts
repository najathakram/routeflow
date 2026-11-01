import { randomUUID } from "crypto";
import { withAdvisoryLock } from "../db-locks";

type LockFamily = Parameters<typeof withAdvisoryLock>[0]["family"];

/**
 * Test-only: open `connections` lock connections of `family` BEFORE a test needs them, and leave them idle in the
 * pool. A test that holds one lock while a second caller must take another connection otherwise makes that second
 * caller open a cold Postgres connection inside the lock pool's 5 s checkout budget (`connectionTimeoutMillis`),
 * which a loaded host can exceed: the caller then fails with `LockUnavailableError` ("Order lock unavailable")
 * without ever reaching the lock under test. The connections are held at the same moment (every holder waits for
 * the others to arrive, a barrier, not a timer), so the pool really has `connections` distinct sessions.
 */
export async function warmLockPool(family: LockFamily, connections = 2): Promise<void> {
  let arrived = 0;
  let open: () => void = () => {};
  const allHere = new Promise<void>((resolve) => {
    open = resolve;
  });
  await Promise.all(
    Array.from({ length: connections }, () =>
      withAdvisoryLock({ family, key: `warm-${randomUUID()}`, mode: "wait" }, async () => {
        arrived += 1;
        if (arrived === connections) open();
        await allHere;
      }),
    ),
  );
}
