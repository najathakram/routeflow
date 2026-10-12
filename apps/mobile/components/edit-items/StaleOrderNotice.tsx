import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { ios } from "@routeflow/ui/tokens";
import {
  ORDER_STALE_COPY,
  captureOpenRevision,
  expectedRevisionBody,
  isOrderRevisionStale,
  rebaseRevision,
} from "../../lib/order-revision-guard";
import { rebaseEditOnReload } from "../../lib/edit-items-draft";
import { styles } from "./styles";

/**
 * Row 262 (web: OrderStaleNotice.tsx). The editor judges its save against the revision it
 * OPENED with (a refetch while typing must not move it). A 409 ORDER_REVISION_STALE shows the
 * fixed copy and refetches the order; the typed edits live in the screen's own state and are
 * left alone. Reload re-bases the revision, so the next save is judged against the latest.
 */
export function useOrderStaleRevision<O extends { revisionNumber?: number }>(
  order: O | undefined,
  id: string,
  /** Staged edit + setters; used on explicit Reload only (rebaseEditOnReload). */
  edit: {
    draft: Record<string, any>;
    unlisted: any[];
    pendingDeletes: string[];
    setDraft: (d: any) => void;
    setUnlisted: (u: any[]) => void;
    setPendingDeletes: (p: string[]) => void;
  },
) {
  const qc = useQueryClient();
  const opened = useRef<number | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [, bump] = useState(0);
  // The order as the editor OPENED: the diff baseline, frozen until an explicit Reload.
  const frozen = useRef<O | undefined>(undefined);
  frozen.current = frozen.current ?? order;
  opened.current = captureOpenRevision(opened.current, order?.revisionNumber);

  const queryKey = ["admin", "orders", id];
  const reload = async () => {
    await qc.refetchQueries({ queryKey });
    const fresh = qc.getQueryData<O>(queryKey);
    if (fresh && frozen.current) {
      const r = rebaseEditOnReload({ frozen: frozen.current, fresh, ...edit });
      edit.setDraft(r.draft);
      edit.setUnlisted(r.unlisted);
      edit.setPendingDeletes(r.pendingDeletes);
    }
    if (fresh) frozen.current = fresh;
    opened.current = rebaseRevision(fresh?.revisionNumber);
    setStale(false);
    bump((n) => n + 1);
  };

  return {
    /** The order as opened (live order until loaded). */
    baseline: frozen.current,
    /** Spread into the PATCH body. */
    body: () => expectedRevisionBody(opened.current),
    /** True when `err` was the stale 409 (handled here; refetches in the background). */
    capture: (err: unknown): boolean => {
      if (!isOrderRevisionStale(err)) return false;
      setStale(true);
      void qc.refetchQueries({ queryKey });
      return true;
    },
    node: stale ? (
      <View style={styles.restoreBanner} accessibilityRole="alert">
        <Ionicons name="alert-circle-outline" size={16} color={ios.brand} />
        <Text style={styles.restoreText}>{ORDER_STALE_COPY}</Text>
        <Pressable
          onPress={() => void reload()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Reload order"
        >
          <Text style={styles.restoreAction}>Reload</Text>
        </Pressable>
      </View>
    ) : null,
  };
}
