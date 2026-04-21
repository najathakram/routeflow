import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { FormField, FormTextInput } from "../../../../../components/FormSheet";
import { usePodStore } from "../../../../../store/podStore";

export default function StopNoteScreen() {
  const router = useRouter();
  const { stopId } = useLocalSearchParams<{ stopId: string }>();
  const stored = usePodStore((s) => (stopId ? s.pods[stopId]?.note ?? "" : ""));
  const setNote = usePodStore((s) => s.setNote);
  const [text, setText] = useState(stored);

  const save = () => {
    if (!stopId) return;
    setNote(stopId, text.trim());
    router.back();
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <NavBar
        inlineTitle="Driver note"
        leading={<NavBackButton label="Stop" onPress={() => router.back()} />}
      />
      <View style={{ padding: 16, gap: 12 }}>
        <Text style={styles.help}>
          Anything operations should know about this stop — left at side door, customer not
          home, etc.
        </Text>
        <FormField label="Note">
          <FormTextInput
            value={text}
            onChangeText={setText}
            placeholder="Type a note…"
            multiline
            numberOfLines={6}
            textAlignVertical="top"
            style={{ minHeight: 140 }}
          />
        </FormField>
      </View>
      <View style={{ flex: 1 }} />
      <View style={styles.footer}>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => router.back()}>
          <Text style={styles.btnSecondaryText}>Cancel</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnPrimary]} onPress={save}>
          <Text style={styles.btnPrimaryText}>Save note</Text>
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
