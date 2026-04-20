import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavAction,
  NavBar,
  SearchBar,
} from "@routeflow/ui/mobile/ios";

interface Message {
  who: string;
  msg: string;
  time: string;
  unread: boolean;
  pinned?: boolean;
  color: string;
  init: string;
  category: "Dispatch" | "Drivers" | "Customers" | "Broadcast";
}

// TODO: replace with /messages endpoint or websocket feed
const MOCK_MESSAGES: readonly Message[] = [
  {
    who: "Dispatch · Jamie",
    msg: "Harbor Café is cash-only today — bring exact change if you can.",
    time: "8:42",
    unread: true,
    pinned: true,
    color: "#0B6E6B",
    init: "DJ",
    category: "Dispatch",
  },
  {
    who: "Luna Roastery",
    msg: "Can we add 3 × croissants to today's drop?",
    time: "8:18",
    unread: true,
    color: "#D28CB5",
    init: "LR",
    category: "Customers",
  },
  {
    who: "Route 11 · Dmitri",
    msg: "Running 10 min behind on stop 4, traffic.",
    time: "Yesterday",
    unread: false,
    color: "#5856D6",
    init: "DK",
    category: "Drivers",
  },
  {
    who: "Broadcast · Ops",
    msg: "Reminder: end-of-day reconcile by 17:30.",
    time: "Yesterday",
    unread: false,
    color: "#8E8E93",
    init: "OP",
    category: "Broadcast",
  },
  {
    who: "Green Market",
    msg: "Thanks — received invoice 9821.",
    time: "Tue",
    unread: false,
    color: "#34C759",
    init: "GM",
    category: "Customers",
  },
];

export function MessagesScreen() {
  const [filter, setFilter] = useState("All");

  const filtered = MOCK_MESSAGES.filter(
    (m) => filter === "All" || m.category === filter,
  );

  const chips = [
    { label: "All", count: MOCK_MESSAGES.filter((m) => m.unread).length },
    { label: "Dispatch", count: MOCK_MESSAGES.filter((m) => m.category === "Dispatch" && m.unread).length },
    { label: "Drivers", count: MOCK_MESSAGES.filter((m) => m.category === "Drivers" && m.unread).length },
    { label: "Customers", count: MOCK_MESSAGES.filter((m) => m.category === "Customers" && m.unread).length },
    { label: "Broadcast", count: 0 },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Messages"
        leading={<NavAction label="Edit" />}
        trailing={<Ionicons name="create-outline" size={22} color={ios.brand} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <SearchBar
          placeholder="Search"
          trailing={
            <View style={styles.filterBtn}>
              <Ionicons name="share-outline" size={12} color={ios.label2} />
            </View>
          }
        />

        <FilterChipRow chips={chips} value={filter} onChange={setFilter} />

        <View style={{ paddingTop: 10 }}>
          {filtered.map((m, i) => (
            <View key={`${m.who}-${i}`} style={styles.msgRow}>
              <View style={[styles.unreadDotWrap]}>
                {m.unread ? <View style={styles.unreadDot} /> : null}
              </View>
              <View style={[styles.avatar, { backgroundColor: m.color }]}>
                <Text style={styles.avatarText}>{m.init}</Text>
              </View>
              <View style={styles.textBlock}>
                <View style={styles.nameRow}>
                  <Text
                    style={[styles.name, m.unread && styles.nameUnread]}
                    numberOfLines={1}
                  >
                    {m.pinned ? "★ " : ""}
                    {m.who}
                  </Text>
                  <Text style={styles.time}>{m.time}</Text>
                </View>
                <Text
                  style={[styles.preview, m.unread && styles.previewUnread]}
                  numberOfLines={2}
                >
                  {m.msg}
                </Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  filterBtn: {
    width: 24,
    height: 24,
    backgroundColor: ios.fill3,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  msgRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  unreadDotWrap: {
    width: 10,
    alignItems: "center",
    paddingTop: 18,
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: ios.brand,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontSize: 15,
    fontFamily: "Inter_700Bold",
  },
  textBlock: { flex: 1, minWidth: 0 },
  nameRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 6,
  },
  name: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
    flex: 1,
  },
  nameUnread: {
    fontFamily: "Inter_700Bold",
  },
  time: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  preview: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    lineHeight: 20,
  },
  previewUnread: {
    color: ios.label,
  },
});
