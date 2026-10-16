"use client";

import * as React from "react";
import { Button } from "@routeflow/ui/web";

/** Did the save fail because the ladder moved on (409 LADDER_REVISION_STALE)? */
export function isLadderRevisionStale(err: unknown): boolean {
  const res = (err as { response?: { status?: unknown; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 409 && res.data?.code === "LADDER_REVISION_STALE";
}

/** The save bar mounts this when `isLadderRevisionStale(err)`; `onReload` refetches the ladder. */
export function StaleRevisionNotice({ onReload }: { onReload: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 rounded-ctl border border-danger/40 bg-danger/5 px-3 py-2 text-[13px] text-navy"
    >
      <span>Prices changed since you opened this; review and save again</span>
      <Button type="button" size="sm" variant="secondary" onClick={onReload}>
        Reload prices
      </Button>
    </div>
  );
}
