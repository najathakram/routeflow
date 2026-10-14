import * as React from "react";
import { StyleSheet, Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { ios } from "@routeflow/ui/tokens";
import { apiClient } from "../lib/api-client";
import {
  restrictionOverrideLine,
  type OverrideStampSource,
} from "../lib/restriction-override-note";

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
    <Text style={styles.note} testID="restriction-override-note">
      {restrictionOverrideLine({ reason, name, at: line.restrictionOverrideAt })}
    </Text>
  );
}

/**
 * Row 510: "Sold despite restriction · <reason> · by <name> · <when>" under a STAFF order or invoice line that was sold
 * with an override (mobile twin of web's RestrictionOverrideNote). Staff screens only: the API never sends the stamp on
 * a buyer read and no (customer) screen imports this. A line with no stamp renders nothing (and runs no lookup).
 */
export function RestrictionOverrideNote({ line }: { line: object | null | undefined }) {
  // Any staff line shape is accepted (the order and invoice read types differ); only the stamp fields are read.
  const stamp = line as OverrideStampSource | null | undefined;
  const reason = stamp?.restrictionOverrideReason?.trim();
  if (!stamp || !reason) return null;
  return <NoteBody line={stamp} reason={reason} />;
}

const styles = StyleSheet.create({
  note: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.system.orangeInk, marginTop: 2 },
});
