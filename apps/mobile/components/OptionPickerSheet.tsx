import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";

export interface PickerOption {
  id: string;
  label: string;
}

interface Props {
  visible: boolean;
  title: string;
  options: PickerOption[];
  selectedId?: string;
  onClose: () => void;
  onSelect: (opt: PickerOption) => void;
  nullable?: boolean;
  nullLabel?: string;
}

export function OptionPickerSheet({
  visible,
  title,
  options,
  selectedId,
  onClose,
  onSelect,
  nullable = false,
  nullLabel = "None",
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>{title}</Text>
        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 420 }}>
          {nullable ? (
            <Pressable
              style={[styles.row, !selectedId && styles.rowActive]}
              onPress={() => { onSelect({ id: "", label: nullLabel }); }}
            >
              <Text style={[styles.rowText, !selectedId && styles.rowTextActive]}>{nullLabel}</Text>
              {!selectedId ? <Ionicons name="checkmark" size={16} color={ios.brand} /> : null}
            </Pressable>
          ) : null}
          {options.length === 0 ? (
            <Text style={styles.empty}>No options available.</Text>
          ) : (
            options.map((opt) => {
              const active = opt.id === selectedId;
              return (
                <Pressable
                  key={opt.id}
                  style={[styles.row, active && styles.rowActive]}
                  onPress={() => onSelect(opt)}
                >
                  <Text style={[styles.rowText, active && styles.rowTextActive]} numberOfLines={1}>
                    {opt.label}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={16} color={ios.brand} /> : null}
                </Pressable>
              );
            })
          )}
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
    maxHeight: "70%",
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
  empty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    padding: 20,
    textAlign: "center",
  },
});
