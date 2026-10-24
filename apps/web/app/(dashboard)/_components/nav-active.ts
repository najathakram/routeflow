/**
 * The href of the ONE nav leaf that is active for `pathname`: the longest leaf href that equals the
 * path or is a segment-boundary prefix of it. Returns null when no leaf matches.
 *
 * A bare `pathname.startsWith(href)` lit every ancestor (Today's route `/routes/my-runs` AND My Routes
 * `/routes`) and matched across segments (`/routes-archive` lit `/routes`).
 */
export function activeLeafHref(leaves: { href: string }[], pathname: string): string | null {
  let best: string | null = null;
  for (const leaf of leaves) {
    const matches = pathname === leaf.href || pathname.startsWith(leaf.href + "/");
    if (matches && (best === null || leaf.href.length > best.length)) best = leaf.href;
  }
  return best;
}
