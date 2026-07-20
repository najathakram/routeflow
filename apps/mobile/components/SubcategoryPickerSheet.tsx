import * as React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { useCreateSubcategory, useTrackedSubcategories } from "../lib/api/tracked-categories";
import { subcategoryPickerOptions } from "../lib/regulated-format";

interface Props {
  visible: boolean;
  /** Parent section — null disables lookups (sheet still opens empty). */
  sectionId: string | null;
  selectedId?: string;
  onClose: () => void;
  /** Fires with the picked/created subcategory id ("" = None). */
  onSelect: (id: string) => void;
}

/**
 * Subcategory variant of OptionPickerSheet — adds a search/create TextInput.
 * Copies OptionPickerSheet's Modal/backdrop/list structure rather than
 * modifying the shared component (other pickers still use the plain one).
 */
export function SubcategoryPickerSheet({
  visible,
  sectionId,
  selectedId,
  onClose,
  onSelect,
}: Props) {
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const { data: subcategories = [], refetch } = useTrackedSubcategories(sectionId || undefined);
  const createSub = useCreateSubcategory();

  React.useEffect(() => {
    if (visible) {
      setQuery("");
      setError(null);
    }
  }, [visible]);

  const options = subcategoryPickerOptions(subcategories, selectedId);
  const q = query.trim();
  const filtered = q
    ? options.filter((o) => o.name.toLowerCase().includes(q.toLowerCase()))
    : options;
  const exactMatch = q ? options.find((o) => o.name.toLowerCase() === q.toLowerCase()) : undefined;
  const showCreate = !!q && !exactMatch;

  const handleCreate = async () => {
    if (!sectionId || !q || createSub.isPending) return;
    setError(null);
    try {
      const created = await createSub.mutateAsync({ categoryId: sectionId, name: q });
      onSelect(created.id);
      setQuery("");
      onClose();
    } catch (e: any) {
      // 409 race backstop: someone minted the same (case-insensitive) name
      // between our pre-guard and this request. Refetch the raw list (includes
      // inactive) and select the winner instead of leaving a bare error.
      if (e?.response?.status === 409) {
        const { data: fresh = [] } = await refetch();
        const match = fresh.find((s) => s.name.trim().toLowerCase() === q.toLowerCase());
        if (match) {
          onSelect(match.id);
          setQuery("");
          onClose();
          return;
        }
      }
      setError(e?.response?.data?.message || "Couldn't create category.");
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Category</Text>
        <View style={styles.searchWrap}>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={(v) => {
              setQuery(v);
              setError(null);
            }}
            placeholder="Search or type a new category…"
            placeholderTextColor={ios.label3}
            autoCapitalize="words"
            autoCorrect={false}
          />
        </View>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 380 }}>
          <Pressable
            style={[styles.row, !selectedId && styles.rowActive]}
            onPress={() => {
              onSelect("");
              onClose();
            }}
          >
            <Text style={[styles.rowText, !selectedId && styles.rowTextActive]}>None</Text>
            {!selectedId ? <Ionicons name="checkmark" size={16} color={ios.brand} /> : null}
          </Pressable>
          {filtered.length === 0 && !showCreate ? (
            <Text style={styles.empty}>No options available.</Text>
          ) : (
            filtered.map((opt) => {
              const active = opt.id === selectedId;
              return (
                <Pressable
                  key={opt.id}
                  style={[styles.row, active && styles.rowActive]}
                  onPress={() => {
                    onSelect(opt.id);
                    setQuery("");
                    onClose();
                  }}
                >
                  <Text style={[styles.rowText, active && styles.rowTextActive]} numberOfLines={1}>
                    {opt.name + (opt.inactive ? " (inactive)" : "")}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={16} color={ios.brand} /> : null}
                </Pressable>
              );
            })
          )}
          {showCreate ? (
            <Pressable
              style={[styles.row, styles.createRow]}
              onPress={handleCreate}
              disabled={createSub.isPending}
            >
              <Text style={styles.createText} numberOfLines={1}>
                {createSub.isPending ? "Creating…" : `+ Create "${q}"`}
              </Text>
            </Pressable>
          ) : null}
          <View style={{ height: 24 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 0,
    paddingTop: 10,
    paddingBottom: 0,
    maxHeight: "80%",
    maxWidth: 480,
    width: "100%",
    alignSelf: "center",
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.separator,
    alignSelf: "center",
    marginBottom: 12,
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  searchWrap: {
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  searchInput: {
    backgroundColor: ios.bg,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  errorText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.system.redInk,
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  rowActive: { backgroundColor: ios.brandWash },
  rowText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  rowTextActive: { fontFamily: "Inter_600SemiBold", color: ios.brand },
  createRow: {},
  createText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    flex: 1,
  },
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    padding: 20,
    textAlign: "center",
  },
});
