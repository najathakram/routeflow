/**
 * Internal comments on the customer file — mobile mirror of web's Comments
 * tab: composer + newest-first cards + delete. Distinct from the single
 * `Customer.notes` field. The server does not include the author relation,
 * so no name is rendered (web has the same limitation).
 */
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useAddCustomerComment,
  useCustomerComments,
  useDeleteCustomerComment,
  type CustomerComment,
} from "../../../../lib/api/customers";
import { showToast } from "../../../../lib/toast";
import { confirm } from "../../../../lib/confirm";

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function CustomerCommentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const customerId = id!;

  const { data, isLoading, isFetching, refetch, isError } = useCustomerComments(customerId);
  const addMut = useAddCustomerComment(customerId);
  const deleteMut = useDeleteCustomerComment(customerId);
  const [draft, setDraft] = useState("");

  const comments = data ?? [];

  const submit = () => {
    const content = draft.trim();
    if (!content) return;
    addMut.mutate(content, {
      onSuccess: () => setDraft(""),
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  const onDelete = (c: CustomerComment) =>
    confirm(
      "Delete comment?",
      "This cannot be undone.",
      () =>
        deleteMut.mutate(c.id, {
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Comments"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Add an internal note about this customer…"
            placeholderTextColor={ios.label3}
            multiline
            accessibilityLabel="New comment"
          />
          <Pressable
            style={[styles.sendBtn, (!draft.trim() || addMut.isPending) && styles.sendBtnOff]}
            onPress={submit}
            disabled={!draft.trim() || addMut.isPending}
            accessibilityLabel="Add comment"
          >
            {addMut.isPending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="arrow-up" size={18} color="#fff" />
            )}
          </Pressable>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
          }
        >
          {isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={ios.brand} />
            </View>
          ) : isError ? (
            <View style={styles.center}>
              <Text style={styles.empty}>Couldn&apos;t load comments. Pull to retry.</Text>
            </View>
          ) : comments.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.empty}>
                No comments yet. Notes here are internal — the customer never sees them.
              </Text>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
              {comments.map((c) => (
                <View key={c.id} style={styles.row}>
                  <View style={styles.rowHead}>
                    <Text style={styles.when}>{timeAgo(c.createdAt)}</Text>
                    <Pressable
                      style={styles.iconBtn}
                      hitSlop={8}
                      onPress={() => onDelete(c)}
                      accessibilityLabel="Delete comment"
                    >
                      <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
                    </Pressable>
                  </View>
                  <Text style={styles.content}>{c.content}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 12,
    backgroundColor: ios.bgElev,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnOff: { opacity: 0.4 },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  when: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  iconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  content: { marginTop: 4, fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label },
});
