import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FilterChipRow,
  NavAction,
  NavBackButton,
  NavBar,
  SearchBar,
  SegmentedControl,
} from "@routeflow/ui/mobile/ios";

// TODO: wire products endpoint + POST /orders for driver-initiated orders.
const PRODUCTS = [
  { name: "Sourdough Loaf", sku: "4021", price: "$6.80", qty: 6, img: ["#C9A27A", "#8B6A44"] as const },
  { name: "Butter (500g)", sku: "1108", price: "$9.20", qty: 4, img: ["#F5E29A", "#D8B954"] as const },
  { name: "Croissants (6pk)", sku: "3302", price: "$14.00", qty: 2, img: ["#E3BE83", "#B1833F"] as const },
  { name: "Pain au chocolat", sku: "3308", price: "$3.50", qty: 0, img: ["#8B5A2B", "#4A2E17"] as const },
  { name: "Raw milk (2L)", sku: "2201", price: "$5.60", qty: 0, img: ["#F4F4F4", "#D9D9D9"] as const },
];

export default function NewOrderScreen() {
  const router = useRouter();
  const [mode, setMode] = useState("Order");
  const [category, setCategory] = useState("Favourites");
  const [items, setItems] = useState<Record<string, number>>({
    "4021": 6,
    "1108": 4,
    "3302": 2,
  });

  const chips = [
    { label: "Favourites" },
    { label: "Bakery" },
    { label: "Dairy" },
    { label: "Produce" },
    { label: "Dry" },
  ];

  const totalItems = Object.values(items).reduce((a, b) => a + b, 0);
  const total = PRODUCTS.reduce((sum, p) => {
    const q = items[p.sku] ?? 0;
    return sum + q * Number(p.price.replace("$", ""));
  }, 0);

  const inc = (sku: string) => setItems((m) => ({ ...m, [sku]: (m[sku] ?? 0) + 1 }));
  const dec = (sku: string) =>
    setItems((m) => ({ ...m, [sku]: Math.max(0, (m[sku] ?? 0) - 1) }));

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="New order"
        leading={<NavBackButton label="Harbor Café" onPress={() => router.back()} />}
        trailing={<NavAction label="Save" bold />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 10 }}>
          <SegmentedControl
            items={["Order", "Return", "Credit note"]}
            value={mode}
            onChange={setMode}
          />
        </View>

        <SearchBar
          placeholder="Search or scan item…"
          trailing={<Ionicons name="barcode-outline" size={18} color={ios.label2} />}
        />

        <FilterChipRow chips={chips} value={category} onChange={setCategory} />

        <View style={{ paddingHorizontal: 16, paddingTop: 14, gap: 10 }}>
          {PRODUCTS.map((p) => {
            const q = items[p.sku] ?? 0;
            return (
              <View key={p.sku} style={styles.productRow}>
                <View
                  style={[
                    styles.productImg,
                    { backgroundColor: p.img[0] },
                  ]}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.productName}>{p.name}</Text>
                  <Text style={styles.productMeta}>
                    SKU {p.sku} · {p.price}
                  </Text>
                </View>
                {q > 0 ? (
                  <View style={styles.stepper}>
                    <Pressable style={styles.stepBtn} onPress={() => dec(p.sku)}>
                      <Text style={styles.stepBtnText}>−</Text>
                    </Pressable>
                    <Text style={styles.stepQty}>{q}</Text>
                    <Pressable style={styles.stepBtn} onPress={() => inc(p.sku)}>
                      <Text style={styles.stepBtnText}>+</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable style={styles.addBtn} onPress={() => inc(p.sku)}>
                    <Text style={styles.addBtnText}>+</Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </View>
        <View style={{ height: 16 }} />
      </ScrollView>

      {/* Sticky cart footer */}
      <View style={styles.footer}>
        <View style={styles.footerRow}>
          <View>
            <Text style={styles.footerEyebrow}>{totalItems} ITEMS · PO-2041</Text>
            <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
          </View>
          <Pressable style={styles.confirmBtn}>
            <Text style={styles.confirmBtnText}>Confirm order</Text>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  productRow: {
    backgroundColor: ios.bg,
    borderRadius: 14,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  productImg: { width: 48, height: 48, borderRadius: 10 },
  productName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  productMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 1,
    fontVariant: ["tabular-nums"],
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: ios.brand, fontSize: 18 },
  stepQty: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  addBtn: {
    width: 36,
    height: 36,
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: {
    color: ios.brand,
    fontSize: 20,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  footerEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.6,
    fontVariant: ["tabular-nums"],
  },
  confirmBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  confirmBtnText: { color: "#fff", fontSize: 16, fontFamily: "Inter_600SemiBold" },
});
