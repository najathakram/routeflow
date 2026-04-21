import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { SignaturePad } from "../../../../../components/SignaturePad";
import { usePodStore } from "../../../../../store/podStore";

export default function StopSignatureScreen() {
  const router = useRouter();
  const { stopId } = useLocalSearchParams<{ stopId: string }>();
  const setSig = usePodStore((s) => s.setSignature);
  const stored = usePodStore((s) => (stopId ? s.pods[stopId]?.signatureUri : undefined));
  const [captured, setCaptured] = useState<boolean>(!!stored);

  const save = () => {
    if (!stopId) return;
    if (!captured) {
      router.back();
      return;
    }
    // The current SignaturePad doesn't expose pixel data — stash a placeholder
    // marker that the server stores as `signatureUrl`. Future enhancement:
    // snapshot the pad to PNG via react-native-view-shot.
    setSig(stopId, `captured:${stopId}:${Date.now()}`);
    router.back();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <NavBar
        inlineTitle="Customer signature"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
      />
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={styles.help}>
          Hand the device to the customer and ask them to sign confirming receipt.
        </Text>
        <SignaturePad onCapture={setCaptured} />
      </View>
      <View style={{ flex: 1 }} />
      <View style={styles.footer}>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => router.back()}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnPrimary, !captured && { opacity: 0.5 }]}
          onPress={save}
          disabled={!captured}
        >
          <Text style={styles.btnPrimaryText}>Save</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  help: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 18 },
  footer: {
    flexDirection: "row",
    gap: 10,
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    backgroundColor: ios.bgElev,
  },
  btn: { flex: 1, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  btnPrimary: { backgroundColor: ios.brand },
  btnPrimaryText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  btnSecondary: { backgroundColor: ios.fill3 },
  btnSecondaryText: { color: ios.label, fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
