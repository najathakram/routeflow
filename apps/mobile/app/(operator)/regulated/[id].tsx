import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useTrackedCategory,
  useToggleTrackedCategory,
  useTrackedSubcategories,
  useCreateSubcategory,
  useUpdateSubcategory,
  useToggleSubcategory,
  type TrackedSubcategory,
} from "../../../lib/api/tracked-categories";
import { taxRuleLabel, treatmentLabel } from "../../../lib/regulated-format";
import { showToast } from "../../../lib/toast";

export default function RegulatedCategoryDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: section, isLoading } = useTrackedCategory(id);
  const toggle = useToggleTrackedCategory();

  if (isLoading || !section) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Section" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Section"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/regulated/${id}/edit`)}
          />
        }
      />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="shield-checkmark-outline" size={18} color={ios.brand} />
              <Text style={styles.name}>{section.name}</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 6, marginTop: 8 }}>
              {section.requiresLicense ? <Pill variant="orange">License required</Pill> : null}
              <Pill variant={section.active ? "green" : "gray"}>
                {section.active ? "Active" : "Off"}
              </Pill>
            </View>
            <Row label="Tax" value={taxRuleLabel(section)} />
            <Row label="Invoice treatment" value={treatmentLabel(section.invoiceTreatment)} />
            <Row label="Report" value={`${section.reportTemplate} · ${section.reportCadence}`} />
            <Row label="Products" value={String(section.productCount)} />
          </View>

          <Pressable
            style={styles.assignBtn}
            onPress={() => router.push(`/(operator)/regulated/${id}/assign-products`)}
          >
            <Ionicons name="cube-outline" size={16} color={ios.brand} />
            <Text style={styles.assignBtnText}>Assign products</Text>
          </Pressable>

          <SubcategoryManager categoryId={id!} />

          <Pressable
            style={styles.toggleBtn}
            onPress={() =>
              toggle.mutate(id!, {
                onSuccess: (updated) =>
                  showToast(updated.active ? "Section activated" : "Section deactivated"),
                onError: (e: any) =>
                  showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
              })
            }
            disabled={toggle.isPending}
          >
            <Ionicons name="power-outline" size={16} color={ios.label} />
            <Text style={styles.toggleBtnText}>
              {section.active ? "Deactivate section" : "Activate section"}
            </Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function SubcategoryManager({ categoryId }: { categoryId: string }) {
  const { data: subs = [], isLoading } = useTrackedSubcategories(categoryId);
  const create = useCreateSubcategory();
  const update = useUpdateSubcategory();
  const toggleSub = useToggleSubcategory();

  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const err = (e: any, fallback: string) => showToast(e?.response?.data?.message ?? fallback);

  const addSub = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { categoryId, name },
      {
        onSuccess: () => {
          setNewName("");
          showToast(`Subcategory "${name}" added`);
        },
        onError: (e) => err(e, "Failed to add subcategory"),
      },
    );
  };

  const startRename = (s: TrackedSubcategory) => {
    setRenamingId(s.id);
    setRenameValue(s.name);
  };
  const saveRename = (s: TrackedSubcategory) => {
    const name = renameValue.trim();
    if (!name || name === s.name) {
      setRenamingId(null);
      return;
    }
    update.mutate(
      { categoryId, subId: s.id, data: { name } },
      {
        onSuccess: () => {
          setRenamingId(null);
          showToast("Subcategory renamed");
        },
        onError: (e) => err(e, "Failed to rename subcategory"),
      },
    );
  };

  const toggleActive = (s: TrackedSubcategory) =>
    toggleSub.mutate(
      { categoryId, subId: s.id },
      {
        onSuccess: (updated) =>
          showToast(updated.active ? `${s.name} activated` : `${s.name} deactivated`),
        onError: (e) => err(e, "Failed to update subcategory"),
      },
    );

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Subcategories</Text>
      {isLoading ? (
        <ActivityIndicator color={ios.brand} style={{ marginVertical: 8 }} />
      ) : subs.length === 0 ? (
        <Text style={styles.subEmpty}>None yet — add subcategories to classify products.</Text>
      ) : (
        subs.map((s) => (
          <View key={s.id} style={styles.subRow}>
            {renamingId === s.id ? (
              <>
                <TextInput
                  autoFocus
                  value={renameValue}
                  onChangeText={setRenameValue}
                  style={styles.subInput}
                  onSubmitEditing={() => saveRename(s)}
                />
                <Pressable onPress={() => saveRename(s)} hitSlop={8}>
                  <Ionicons name="checkmark" size={18} color={ios.brand} />
                </Pressable>
                <Pressable onPress={() => setRenamingId(null)} hitSlop={8}>
                  <Ionicons name="close" size={18} color={ios.label3} />
                </Pressable>
              </>
            ) : (
              <>
                <Text
                  style={[styles.subName, !s.active && { color: ios.label3 }]}
                  numberOfLines={1}
                >
                  {s.name}
                  {!s.active ? " (off)" : ""}
                </Text>
                <Text style={styles.subCount}>{s.productCount}</Text>
                <Pressable onPress={() => startRename(s)} hitSlop={8}>
                  <Ionicons name="pencil-outline" size={16} color={ios.label2} />
                </Pressable>
                <Pressable
                  onPress={() => toggleActive(s)}
                  disabled={toggleSub.isPending}
                  hitSlop={8}
                >
                  <Ionicons name="power-outline" size={16} color={ios.label2} />
                </Pressable>
              </>
            )}
          </View>
        ))
      )}
      <View style={styles.subAddRow}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          placeholder="Add a subcategory…"
          placeholderTextColor={ios.label3}
          style={styles.subInput}
          onSubmitEditing={addSub}
        />
        <Pressable
          style={[styles.subAddBtn, !newName.trim() && { opacity: 0.4 }]}
          onPress={addSub}
          disabled={!newName.trim() || create.isPending}
        >
          <Text style={styles.subAddBtnText}>Add</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 4 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 6 },
  name: { fontSize: 20, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.3 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6 },
  detailLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  detailValue: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  assignBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 12,
  },
  assignBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  subEmpty: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3, paddingVertical: 4 },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  subName: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  subCount: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  subInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  subAddRow: { flexDirection: "row", gap: 8, marginTop: 8, alignItems: "center" },
  subAddBtn: {
    backgroundColor: ios.brand,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  subAddBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  toggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.bgElev,
    paddingVertical: 14,
    borderRadius: 12,
  },
  toggleBtnText: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
});
