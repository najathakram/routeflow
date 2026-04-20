import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  ListGroup,
  NavAction,
  NavBackButton,
  NavBar,
  Pill,
} from "@routeflow/ui/mobile/ios";

const ITEMS = [
  { name: "Sourdough Loaf", sku: "SKU 4021", qty: 6, done: true },
  { name: "Butter (500g)", sku: "SKU 1108", qty: 4, done: true },
  { name: "Croissants (6pk)", sku: "SKU 3302", qty: 2, short: true },
];

export default function StopDetailScreen() {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Stop 6 / 12"
        leading={<NavBackButton label="Route" onPress={() => router.back()} />}
        trailing={<NavAction label="Call" />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Customer card */}
        <View style={styles.custCard}>
          <View style={styles.custRow}>
            <LinearGradient
              colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatar}
            >
              <Text style={styles.avatarText}>HC</Text>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={styles.custName}>Harbor Café</Text>
              <Text style={styles.custAddr}>42 Harbour St, Sydney NSW 2000</Text>
              <View style={styles.pillRow}>
                <Pill variant="brand">3 items</Pill>
                <Pill variant="orange">$184 due</Pill>
                <Pill variant="red">Overdue $420</Pill>
              </View>
            </View>
          </View>
          <View style={styles.quickActions}>
            <QuickAction icon="call-outline" label="Call" />
            <QuickAction icon="chatbubble-outline" label="Text" />
            <QuickAction icon="location-outline" label="Directions" />
          </View>
        </View>

        {/* Items */}
        <SectionRow title="Items" action="+ Add on-site" />
        <ListGroup>
          {ITEMS.map((i) => (
            <View key={i.name} style={styles.itemRow}>
              <View
                style={[
                  styles.check,
                  i.done ? { backgroundColor: ios.system.green, borderWidth: 0 } : null,
                ]}
              >
                {i.done ? (
                  <Ionicons name="checkmark" size={13} color="#fff" />
                ) : null}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{i.name}</Text>
                <Text style={styles.itemSku}>{i.sku}</Text>
              </View>
              {i.short ? (
                <View style={{ marginRight: 8 }}>
                  <Pill variant="orange" small>Short</Pill>
                </View>
              ) : null}
              <View style={styles.qtyBadge}>
                <Text style={styles.qtyText}>×{i.qty}</Text>
              </View>
            </View>
          ))}
        </ListGroup>

        {/* POD */}
        <SectionRow title="Proof of delivery" />
        <View style={styles.podRow}>
          <PodTile icon="camera-outline" label="Photo" />
          <PodTile icon="create-outline" label="Signature" />
          <PodTile icon="chatbubble-outline" label="Note" />
        </View>

        {/* Actions */}
        <View style={styles.actionsBlock}>
          <View style={styles.actionBtnRow}>
            <SecondaryBtn label="Attempted" />
            <SecondaryBtn label="Partial return" onPress={() => router.push("./return")} />
          </View>
          <Pressable
            style={styles.greenBtn}
            onPress={() => router.push("./payment")}
          >
            <Text style={styles.greenBtnText}>Complete & collect →</Text>
          </Pressable>
        </View>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function QuickAction({
  icon,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  return (
    <View style={styles.qa}>
      <Ionicons name={icon} size={15} color={ios.label} />
      <Text style={styles.qaLabel}>{label}</Text>
    </View>
  );
}

function PodTile({
  icon,
  label,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
}) {
  return (
    <View style={styles.podTile}>
      <Ionicons name={icon} size={22} color={ios.label2} />
      <Text style={styles.podTileLabel}>{label}</Text>
    </View>
  );
}

function SectionRow({ title, action }: { title: string; action?: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action ? <Text style={styles.sectionLink}>{action}</Text> : null}
    </View>
  );
}

function SecondaryBtn({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.secondaryBtn}>
      <Text style={styles.secondaryBtnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  custCard: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  custRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 18, fontFamily: "Inter_700Bold", letterSpacing: -0.5 },
  custName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.4,
  },
  custAddr: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  pillRow: { flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" },
  quickActions: { flexDirection: "row", gap: 6, marginTop: 14 },
  qa: {
    flex: 1,
    padding: 10,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  qaLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  sectionLink: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.brand },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: ios.bgElev,
    minHeight: 44,
  },
  check: {
    width: 26,
    height: 26,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: ios.gray[3],
    alignItems: "center",
    justifyContent: "center",
  },
  itemName: { fontSize: 16, fontFamily: "Inter_500Medium", color: ios.label },
  itemSku: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  qtyBadge: {
    backgroundColor: ios.brandWash,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  qtyText: {
    color: ios.brand,
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  podRow: { paddingHorizontal: 16, flexDirection: "row", gap: 10 },
  podTile: {
    flex: 1,
    height: 96,
    backgroundColor: ios.fill3,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: ios.gray[3],
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  podTileLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  actionsBlock: { padding: 16, gap: 8 },
  actionBtnRow: { flexDirection: "row", gap: 10 },
  secondaryBtn: {
    flex: 1,
    backgroundColor: ios.fill2,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryBtnText: {
    color: ios.brand,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  greenBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  greenBtnText: {
    color: "#fff",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.2,
  },
});
