import * as React from "react";
import { StyleSheet, Text } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import {
  restrictionOverrideNoteOf,
  type OverrideStampSource,
} from "../lib/restriction-override-note";

/**
 * Row 510: "Sold despite restriction · <reason> · by <name> · <when>" under a STAFF order or invoice line that was sold
 * with an override (mobile twin of web's RestrictionOverrideNote). Staff screens only: the API never sends the stamp on
 * a buyer read and no (customer) screen imports this. A line with no stamp renders nothing.
 *
 * The name is the API's own `restrictionOverrideByName` (always sent on a staff line): a name, or null when the user is
 * gone, which reads "former user". The note fetches nothing: user management is admin-only, so a lookup from an
 * operator's screen would 403 and falsely read "former user".
 */
export function RestrictionOverrideNote({ line }: { line: object | null | undefined }) {
  // Any staff line shape is accepted (the order and invoice read types differ); only the stamp fields are read.
  const text = restrictionOverrideNoteOf(line as OverrideStampSource | null | undefined);
  if (!text) return null;
  return (
    <Text style={styles.note} testID="restriction-override-note">
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  note: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.system.orangeInk,
    marginTop: 2,
  },
});
