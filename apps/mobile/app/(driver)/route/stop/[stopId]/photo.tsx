import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { PhotoCapture } from "../../../../../components/PhotoCapture";
import { usePodStore } from "../../../../../store/podStore";

export default function StopPhotoScreen() {
  const router = useRouter();
  const { stopId } = useLocalSearchParams<{ stopId: string }>();
  const stored = usePodStore((s) => (stopId ? s.pods[stopId]?.photoUrls ?? [] : []));
  const setPhotos = usePodStore((s) => s.setPhotos);
  const [photos, setLocal] = useState<string[]>(stored);

  const backToStop = () => {
    if (stopId) {
      router.replace(`/(driver)/route/stop/${stopId}` as any);
    } else {
      router.replace("/(driver)/route" as any);
    }
  };

  const save = () => {
    if (!stopId) return;
    setPhotos(stopId, photos);
    backToStop();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <NavBar
        inlineTitle="Proof photos"
        leading={<NavBackButton label="Stop" onPress={backToStop} />}
      />
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={styles.help}>
          Capture up to 3 photos showing the delivered goods. They'll be attached to this stop
          when you complete it.
        </Text>
        <PhotoCapture
          photos={photos}
          onAdd={(uri) => setLocal((p) => [...p, uri])}
          onRemove={(uri) => setLocal((p) => p.filter((u) => u !== uri))}
          maxPhotos={3}
        />
      </View>
      <View style={{ flex: 1 }} />
      <View style={styles.footer}>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={backToStop}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={save}>
          <Text style={styles.btnPrimaryText}>Save photos</Text>
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
