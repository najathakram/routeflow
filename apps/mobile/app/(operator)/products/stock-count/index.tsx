import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill, type PillVariant } from "@routeflow/ui/mobile/ios";
import { useStartStockCount, useStockCountSessions } from "../../../../lib/api/stock-count";
import type { StockCountSessionSummary } from "../../../../lib/stock-count-logic";
import { chooseAction } from "../../../../lib/confirm";
import { showToast } from "../../../../lib/toast";

/**
 * PR-C entry point: start a new durable stock-count session, or resume one
 * already OPEN/REVIEW from the "Continue count" strip (mirrors DraftStrip's
 * placement — the screen you land on before starting fresh, not the busy
 * Warehouse dashboard itself). Reached from the Warehouse tab's existing
 * "Count" quick action (app/(operator)/(tabs)/warehouse.tsx), which already
 * points at this route.
 */
export default function StockCountHubScreen() {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const openQuery = useStockCountSessions({ status: "OPEN", limit: 10 });
  const reviewQuery = useStockCountSessions({ status: "REVIEW", limit: 10 });
  const startMut = useStartStockCount();

  const resumable = [...(openQuery.data?.data ?? []), ...(reviewQuery.data?.data ?? [])].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const isLoading = openQuery.isLoading || reviewQuery.isLoading;

  const goToSession = (id: string) => router.push(`/(operator)/products/stock-count/${id}` as any);

  const startNew = () => {
    if (starting) return;
    setStarting(true);
    startMut.mutate(
      {},
      {
        onSuccess: (session) => {
          setStarting(false);
          const others = session.otherOpenSessions.filter((s) => s.id !== session.id);
          if (others.length === 0) {
            goToSession(session.id);
            return;
          }
          // A WARNING, not a lock — the new session already exists; offer to
          // work the older one instead, but never block the fresh one.
          const other = others[0];
          chooseAction(
            "You already have an open count",
            `"${other.name?.trim() || "Untitled count"}" is still open${
              others.length > 1 ? ` (+${others.length - 1} more)` : ""
            }. This new count was started too — you can work either one.`,
            [
              {
                label: `Open "${other.name?.trim() || "Untitled count"}"`,
                onPress: () => goToSession(other.id),
              },
              {
                label: "Continue new count",
                style: "default",
                onPress: () => goToSession(session.id),
              },
            ],
          );
        },
        onError: (e: any) => {
          setStarting(false);
          showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't start a new count.");
        },
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Stock count"
        leading={<NavBackButton label="Warehouse" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="History"
            onPress={() => router.push("/(operator)/products/stock-counts" as any)}
          />
        }
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : resumable.length > 0 ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionTitle}>Continue count</Text>
            {resumable.map((s) => (
              <ContinueCountCard key={s.id} session={s} onPress={() => goToSession(s.id)} />
            ))}
          </View>
        ) : null}

        <Pressable
          style={[styles.startBtn, starting && { opacity: 0.6 }]}
          onPress={startNew}
          disabled={starting}
        >
          {starting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="scan-outline" size={18} color="#fff" />
              <Text style={styles.startBtnText}>Start new count</Text>
            </>
          )}
        </Pressable>

        <Text style={styles.hint}>
          A count autosaves as you scan — pause any time and pick it up on any device. Uncounted
          products are never touched.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const STATUS_PILL: Record<string, PillVariant> = { OPEN: "brand", REVIEW: "orange" };

function ContinueCountCard({
  session,
  onPress,
}: {
  session: StockCountSessionSummary;
  onPress: () => void;
}) {
  const lineCount = session._count?.lines ?? 0;
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {session.name?.trim() || "Untitled count"}
        </Text>
        <Pill variant={STATUS_PILL[session.status] ?? "gray"} small>
          {session.status === "REVIEW" ? "In review" : "Open"}
        </Pill>
      </View>
      <Text style={styles.cardSub}>
        {lineCount} line{lineCount === 1 ? "" : "s"} counted · started by{" "}
        {session.startedBy?.username ?? "someone"} · {timeAgo(session.startedAt)}
      </Text>
    </Pressable>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.2,
  },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { flex: 1, fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  cardSub: { fontSize: 12.5, fontFamily: "Inter_400Regular", color: ios.label2 },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
  },
  startBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
  hint: {
    fontSize: 12.5,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    paddingHorizontal: 8,
  },
});
