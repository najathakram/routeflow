/**
 * B449 fix-round finding 2: a tiny cross-component bridge between `PlanGateBoundary`
 * (app/(dashboard)/_components/gates/PlanGateBoundary.tsx) and `PlanGateNotice`
 * (components/PlanGateNotice.tsx). `PlanGateBoundary` marks a pathname LOCKED the
 * moment it decides to render the lock (and unmarks it the moment it stops), so
 * `PlanGateNotice` can refuse to turn a stray 403 into a toast on that path — the
 * boundary itself already emitted the ONE deterministic notice for that navigation,
 * naming the route's own gate tier; a 403 arriving from some other widget must never
 * add a second, possibly-contradictory one.
 */
const lockedPaths = new Set<string>();

export function setRouteLocked(pathname: string, locked: boolean): void {
  if (locked) lockedPaths.add(pathname);
  else lockedPaths.delete(pathname);
}

export function isRouteLocked(pathname: string): boolean {
  return lockedPaths.has(pathname);
}
