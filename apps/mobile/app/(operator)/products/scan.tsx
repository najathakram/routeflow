import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { BarcodeScanner } from "../../../components/BarcodeScanner";
import { apiClient } from "../../../lib/api-client";

export default function ScanProductScreen() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const handleScanned = async (code: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`);
      if (data?.id) {
        router.replace(`/(operator)/products/${data.id}`);
        return;
      }
      router.replace({
        pathname: "/(operator)/products/new",
        params: { barcode: code },
      });
    } catch (err: any) {
      if (err?.response?.status === 404) {
        // Unknown barcode → go to create with prefilled
        router.replace({
          pathname: "/(operator)/products/new",
          params: { barcode: code },
        });
        return;
      }
      Alert.alert(
        "Couldn't look up barcode",
        err?.response?.data?.message ?? err?.message ?? "Try again.",
      );
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
