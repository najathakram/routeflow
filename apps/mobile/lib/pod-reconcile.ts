/**
 * D3 (`.claude/pipeline/2026-09-09-train1-driver-teardown/cause-ruling.md`
 * §3, REG-B136): local POD reconciliation. `pendingPodArtifacts(local,
 * serverStop)` returns only the local artifacts absent from the server
 * (matched by artifact id/hash — see
 * `lib/pod-artifacts.ts#podPhotoArtifactId`), so the stop screen re-attaches
 * only what the server does not already hold after an app-kill relaunch
 * (never a duplicate append, B136).
 *
 * `serverStop.podArtifactIds` is the contract for "what the server already
 * holds" — the caller sources it from the stop payload however it actually
 * ships that id set.
 */
export interface PendingArtifactCandidate {
  /** Stable artifact id/hash — e.g. `podPhotoArtifactId(dataUrl)`. */
  artifactId: string;
  dataUrl: string;
}

export interface ServerPodStop {
  podArtifactIds?: string[];
}

export function pendingPodArtifacts(
  local: PendingArtifactCandidate[],
  serverStop: ServerPodStop | null | undefined,
): PendingArtifactCandidate[] {
  const serverIds = new Set(serverStop?.podArtifactIds ?? []);
  return local.filter((artifact) => !serverIds.has(artifact.artifactId));
}

/**
 * Read back the artifact ids the server already holds for a stop from its
 * `podPhotoUrls`. Stored POD keys are
 * `tenants/<tenant>/pod/<stop>/photo-<artifactId>.<ext>`
 * (`apps/api/src/routes/pod-artifacts.util.ts#podArtifactKey`), which is the
 * same `/photo-<artifactId>.` marker the server's own idempotency guard
 * matches on. Anything that is not one of those keys (a legacy inline data
 * URL, an older app's raw string) yields no id, so it can never mask a
 * capture that still needs attaching.
 */
export function artifactIdsFromPodPhotoUrls(urls: readonly string[] | undefined): string[] {
  const ids: string[] = [];
  for (const url of urls ?? []) {
    const match = /photo-([^./]+)\./.exec(url ?? "");
    if (match) ids.push(match[1]);
  }
  return ids;
}
