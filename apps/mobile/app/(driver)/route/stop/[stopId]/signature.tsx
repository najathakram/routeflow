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
  const [sigUri, setSigUri] = useState<string | null>(stored ?? null);

  const backToStop = () => {
    if (stopId) {
      router.replace(`/(driver)/route/stop/${stopId}` as any);
    } else {
      router.replace("/(driver)/route" as any);
    }
  };

  const save = () => {
    if (!stopId) return;
    if (!sigUri) {
      backToStop();
      return;
    }
    setSig(stopId, sigUri);
    backToStop();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <NavBar
        inlineTitle="Customer signature"
        leading={<NavBackButton label="Stop" onPress={backToStop} />}
      />
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={styles.help}>
          Hand the device to the customer and ask them to sign confirming receipt.
        </Text>
        <SignaturePad onCapture={setSigUri} />
      </View>
      <View style={{ flex: 1 }} />
      <View style={styles.footer}>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={backToStop}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnPrimary, !sigUri && { opacity: 0.5 }]}
          onPress={save}
          disabled={!sigUri}
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
