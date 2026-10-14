"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { restrictionOverrideLine, type OverrideStampSource } from "@/lib/restriction-override-note";

/** The overriding user's name (the username, never an email), or null when the user is gone. */
function useOverrideUserName(
  userId: string | null | undefined,
  resolved: string | null | undefined,
) {
  const q = useQuery<string | null>({
    queryKey: ["users", userId, "override-name"],
    queryFn: async () => {
      try {
        const u = (await apiClient.get(`/users/${userId}`)).data as { username?: string | null };
        return u?.username?.trim() || null;
      } catch {
        return null; // deleted or unreadable: "former user"
      }
    },
    enabled: !!userId && !resolved,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  if (resolved) return resolved;
  if (!userId) return null;
  return q.isLoading ? undefined : (q.data ?? null);
}

function NoteBody({ line, reason }: { line: OverrideStampSource; reason: string }) {
  const name = useOverrideUserName(line.restrictionOverrideBy, line.restrictionOverrideByName);
  return (
    <p
      data-testid="restriction-override-note"
      className="mt-0.5 text-xs font-normal text-amber-800"
    >
      {restrictionOverrideLine({ reason, name, at: line.restrictionOverrideAt })}
    </p>
  );
}

/**
 * Row 510: "Sold despite restriction · <reason> · by <name> · <when>" under a STAFF order or invoice line that was sold
 * with an override. Staff screens only: the API never sends the stamp on a buyer read, and nothing under app/buyer imports
 * this (a pin). A line with no stamp renders nothing (and runs no lookup).
 */
export function RestrictionOverrideNote({
  line,
}: {
  line: OverrideStampSource | null | undefined;
}) {
  const reason = line?.restrictionOverrideReason?.trim();
  if (!line || !reason) return null;
  return <NoteBody line={line} reason={reason} />;
}
