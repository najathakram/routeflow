import { useEffect, useRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { useDrafts, useDeleteDraft, type SaleDraft } from "../lib/api/drafts";
import { draftSummary, parkedAgo, type OrderDraftPayload } from "../lib/drafts-payload";
import { confirm } from "../lib/confirm";

/**
 * Mirrors web's DraftDock (pos-cost-roles-spec §2) for mobile: a horizontal
 * strip of the operator's parked order builders. Renders nothing when there
 * are none — this is a convenience surface, not a persistent chrome element.
 *
 * A draft that has been submitted (poison-pilled in the submit sequence —
 * see NewOrderScreen's `finalizeBoundDraft`) carries `payload.submittedAt`.
 * It must never be offered for resume — the order it belonged to already
 * exists — so it's filtered out here and swept (deleted) the first time this
 * strip sees it, covering the case where the submit-time delete itself
 * failed (offline, timed out).
 */
function isSubmitted(draft: SaleDraft): boolean {
  const payload = draft.payload as (Partial<OrderDraftPayload> & { submittedAt?: string }) | null;
  return !!payload?.submittedAt;
}

export function DraftStrip() {
  const router = useRouter();
  const { data: drafts } = useDrafts();
  const deleteDraft = useDeleteDraft();
  // Sweep guard so a poison-pilled draft is only ever retried once per
  // mount, not on every list refetch while the delete is in flight.
  const sweptRef = useRef<Set<string>>(new Set());

  const list = drafts ?? [];
  const visible = list.filter((d) => !isSubmitted(d));

  useEffect(() => {
    for (const d of list) {
      if (!isSubmitted(d) || sweptRef.current.has(d.id)) continue;
      sweptRef.current.add(d.id);
      deleteDraft.mutate(d.id, { onError: () => {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  if (visible.length === 0) return null;

  const resume = (id: string) => {
    router.push(`/(operator)/new-order?resumeDraft=${encodeURIComponent(id)}` as any);
  };

  const askDiscard = (draft: SaleDraft) => {
    const { title } = draftSummary(draft);
    confirm(
      "Discard this draft?",
      `"${title}" and everything in it will be removed. This cannot be undone.`,
      () => deleteDraft.mutate(draft.id),
      { confirmText: "Discard", destructive: true },
    );
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.wrap}
      contentContainerStyle={styles.content}
    >
      {visible.map((draft) => {
        const { title, itemCount, total } = draftSummary(draft);
        return (
          <Pressable
            key={draft.id}
            style={styles.card}
            onPress={() => resume(draft.id)}
            onLongPress={() => askDiscard(draft)}
            accessibilityRole="button"
            accessibilityLabel={`Resume draft, ${title}`}
          >
            <View style={styles.headRow}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>DRAFT</Text>
              </View>
              <Pressable
                hitSlop={8}
                onPress={() => askDiscard(draft)}
                accessibilityRole="button"
                accessibilityLabel="Discard draft"
              >
                <Ionicons name="close" size={14} color={ios.label2} />
              </Pressable>
            </View>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {itemCount} item{itemCount === 1 ? "" : "s"} ·{" "}
              <Text style={styles.subMoney}>${total.toFixed(2)}</Text> ·{" "}
              {parkedAgo(draft.updatedAt)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 0, marginTop: 4 },
  content: { paddingHorizontal: 16, paddingBottom: 4, gap: 10 },
  card: {
    width: 200,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  badge: {
    backgroundColor: ios.brandWash,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: ios.brand,
    letterSpacing: 0.4,
  },
  title: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  sub: { fontSize: 11.5, fontFamily: "Inter_400Regular", color: ios.label2 },
  subMoney: { fontFamily: "Inter_600SemiBold", color: ios.label },
});
