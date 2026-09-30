import type { FeatureDiffRow } from "../types";

// Tab-header indicator (brief D item 4): this tenant's unexplained-diff count from
// `GET .../features/diffs?tenantId=`. One explained, one not — the badge counts only the latter.
export function diffsFixture(tenantId: string): FeatureDiffRow[] {
  return [
    {
      id: "diff-1",
      tenantId,
      featureKey: "msrp",
      before: false,
      after: true,
      source: "OVERRIDE_GRANT",
      firstSeenAt: "2026-09-10T00:00:00.000Z",
      lastSeenAt: "2026-09-16T00:00:00.000Z",
      count: 6,
      explainedAt: null,
      explanation: null,
    },
    {
      id: "diff-2",
      tenantId,
      featureKey: "tobacco_dealer",
      before: true,
      after: false,
      source: "OVERRIDE_DENY",
      firstSeenAt: "2026-09-05T00:00:00.000Z",
      lastSeenAt: "2026-09-12T00:00:00.000Z",
      count: 3,
      explainedAt: "2026-09-13T00:00:00.000Z",
      explanation: "Expected — compliance review removal, ticket ROAD-63.",
    },
  ];
}
