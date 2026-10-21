"use client";

import * as React from "react";
import { apiClient } from "@/lib/api-client";
import type { DraftMirror } from "@/lib/order-draft/mirror";
import {
  findResumable,
  type ResumeCandidate,
  type ServerDraftSummary,
} from "@/lib/order-draft/resume";

/**
 * SA-817 (A) 3: on opening a fresh order, offer the user's unsent local copies ("Resume your unsent order?"). Only this tenant
 * + user's copies are listed (the mirror is scoped by key). `GET /drafts` is read only when there is something local to compare
 * against, so a normal open costs nothing. A copy the server already holds identically (or whose order was submitted) is dropped
 * quietly; every other copy is kept until it syncs or the user discards it.
 */
export function useUnsentOrderResume(opts: {
  /** The modal is open on a FRESH order (not resuming a docked draft). */
  active: boolean;
  mirror: DraftMirror | null;
  /** Resuming a docked server draft: offer only the local copy bound to THAT draft (null = a fresh open: offer any). */
  onlyFor?: string | null;
}) {
  const { active, mirror, onlyFor = null } = opts;
  const [candidates, setCandidates] = React.useState<ResumeCandidate[]>([]);

  React.useEffect(() => {
    if (!active || !mirror) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const records = await mirror.list();
        if (records.length === 0) return;
        let server: ServerDraftSummary[] = [];
        try {
          const res = await apiClient.get("/drafts");
          server = Array.isArray(res?.data) ? (res.data as ServerDraftSummary[]) : [];
        } catch {
          // offline: nothing to compare with, so every unsynced copy is offered
        }
        const scan = findResumable(records, server);
        for (const gone of scan.obsolete) void mirror.remove(gone.localId);
        const offered = onlyFor
          ? scan.resumable.filter(
              (c) => c.record.serverDraftId === onlyFor || c.record.localId === onlyFor,
            )
          : scan.resumable;
        if (!cancelled) setCandidates(offered);
      } catch {
        // an unreadable local store offers nothing and breaks nothing
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, mirror, onlyFor]);

  return {
    candidates,
    /** The prompt goes away for this open; the copies stay on the device. */
    dismiss: React.useCallback(() => setCandidates([]), []),
    /** The user discards one copy on purpose (the only way a never-synced copy is deleted). */
    discard: React.useCallback(
      (localId: string) => {
        void mirror?.remove(localId);
        setCandidates((prev) => prev.filter((c) => c.record.localId !== localId));
      },
      [mirror],
    ),
  };
}
