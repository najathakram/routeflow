import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { BarcodeScanner } from "../../../components/BarcodeScanner";
import { resolveProductByCode } from "../../../lib/barcode-resolve";
import { showToast } from "../../../lib/toast";

export default function ScanProductScreen() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const handleScanned = async (code: string) => {
    if (busy) return;
    setBusy(true);
    try {
      // Same fallback ladder the web uses: barcode → sku → name search →
      // prompt to create. Recently-added items often don't have a `barcode`
      // assigned yet, so a barcode-only lookup says "not found" even when
      // the SKU label being scanned matches an existing product.
      const result = await resolveProductByCode(code);
      if (result.notFound) {
        router.replace({
          pathname: "/(operator)/products/new",
          params: { barcode: code },
        });
        return;
      }
      router.replace(`/(operator)/products/${result.product.id}`);
    } catch (err: any) {
      showToast(err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode. Try again.");
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <BarcodeScanner onScanned={handleScanned} onClose={() => router.back()} />
      {busy ? (
        <View style={styles.busyOverlay} pointerEvents="box-none">
          <Text style={styles.busyText}>Looking up…</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  busyOverlay: {
    position: "absolute",
    bottom: 120,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  busyText: {
    color: "#fff",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});
