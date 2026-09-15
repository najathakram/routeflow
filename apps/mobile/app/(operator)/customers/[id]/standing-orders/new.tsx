/**
 * Create a standing order for THIS customer — FormSheet builder mirroring
 * web's StandingOrderModal: name, ISO day chips, product lines with qty
 * steppers, notes. Validation rules live in lib/order-templates-logic
 * (`validateTemplateForm`) so the pure spec locks them.
 *
 * Template items carry NO price — generation prices at order time (raw
 * pricePerUnit, no tiers), so no money is rendered here on purpose.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import {
  FormSheet,
  FormField,
  FormSection,
  FormTextInput,
} from "../../../../../components/FormSheet";
import { ProductPickerSheet } from "../../../../../components/ProductPickerSheet";
import { BarcodeFab } from "../../../../../components/BarcodeFab";
import { useCreateOrderTemplate } from "../../../../../lib/api/order-templates";
import { ISO_DAY_OPTIONS, validateTemplateForm } from "../../../../../lib/order-templates-logic";
import { showToast } from "../../../../../lib/toast";
import { hasUnsavedStandingOrder } from "../../../../../lib/discard-guard";
import { archivedMessage, resolveProductByCode } from "../../../../../lib/barcode-resolve";
import type { AdminProduct } from "../../../../../lib/api/admin";

interface Line {
  productId: string;
  name: string;
  unit?: string;
  qty: number;
}

export default function NewStandingOrderScreen() {
  const { id: customerId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const createTemplate = useCreateOrderTemplate();

  const [name, setName] = useState("");
  const [days, setDays] = useState<number[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const toggleDay = (value: number) =>
    setDays((prev) =>
      prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value].sort(),
    );

  const bumpQty = (productId: string, delta: number) =>
    setLines((prev) =>
      prev
        .map((l) => (l.productId === productId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    );

  // Shared by the picker's onSelect and the scan FAB (B266) so a scanned
  // product adds/increments a line exactly like a tapped one.
  const addLine = (product: AdminProduct) =>
    setLines((prev) => {
      const existing = prev.find((l) => l.productId === product.id);
      if (existing) {
        return prev.map((l) => (l.productId === product.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [...prev, { productId: product.id, name: product.name, unit: product.unit, qty: 1 }];
    });

  // B266: this screen had no scan entry outside the product picker sheet —
  // mirrors ProductPickerSheet's own onScanned (same resolve -> archived/
  // not-found handling), feeding scanned lines through the SAME addLine path
  // a tapped pick uses.
  const onScanned = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode<AdminProduct>(trimmed);
      if (result.archived) {
        showToast(archivedMessage(result.product));
        return;
      }
      if (!result.notFound) {
        addLine(result.product);
        return;
      }
    } catch {
      // network error → fall through to the toast
    }
    showToast(`No product for "${trimmed}"`);
  };

  const submit = () => {
    const error = validateTemplateForm({
      name,
      daysOfWeek: days,
      items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
    });
    if (error) {
      showToast(error);
      return;
    }
    createTemplate.mutate(
      {
        customerId: customerId!,
        name: name.trim(),
        daysOfWeek: days,
        notes: notes.trim() || undefined,
        items: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      },
      {
        onSuccess: () => {
          showToast("Standing order created");
          router.back();
        },
        onError: (e: any) => {
          showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");
        },
      },
    );
  };

  // BarcodeFab renders as a SIBLING of FormSheet, not a child — see edit.tsx
  // (invoice edit, B265) for why: FormSheet's children scroll, the FAB must not.
  return (
    <>
    <FormSheet
      title="New standing order"
      subtitle="Orders generate automatically on the chosen days."
      submitLabel="Create"
      onSubmit={submit}
      onCancel={() => router.back()}
      submitting={createTemplate.isPending}
      confirmDiscardIfDirty={hasUnsavedStandingOrder({ name, lines })}
    >
      <FormSection>
        <FormField label="Name">
          <FormTextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Tuesday staples"
            autoFocus
          />
        </FormField>
        <FormField label="Delivery days">
          <View style={styles.dayRow}>
            {ISO_DAY_OPTIONS.map((d) => {
              const on = days.includes(d.value);
              return (
                <Pressable
                  key={d.value}
                  style={[styles.dayChip, on && styles.dayChipOn]}
                  onPress={() => toggleDay(d.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={d.label}
                >
                  <Text style={[styles.dayChipText, on && styles.dayChipTextOn]}>{d.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </FormField>
      </FormSection>

      <FormSection title="Items">
        {lines.map((l) => (
          <View key={l.productId} style={styles.line}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.lineName} numberOfLines={1}>
                {l.name}
              </Text>
              {l.unit ? <Text style={styles.lineUnit}>{l.unit}</Text> : null}
            </View>
            <View style={styles.stepper}>
              <Pressable
                style={styles.stepBtn}
                onPress={() => bumpQty(l.productId, -1)}
                hitSlop={8}
                accessibilityLabel={`Decrease ${l.name}`}
              >
                <Ionicons name="remove" size={18} color={ios.brand} />
              </Pressable>
              <Text style={styles.stepQty}>{l.qty}</Text>
              <Pressable
                style={styles.stepBtn}
                onPress={() => bumpQty(l.productId, 1)}
                hitSlop={8}
                accessibilityLabel={`Increase ${l.name}`}
              >
                <Ionicons name="add" size={18} color={ios.brand} />
              </Pressable>
            </View>
          </View>
        ))}
        <Pressable style={styles.addBtn} onPress={() => setPickerOpen(true)}>
          <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
          <Text style={styles.addBtnText}>Add product</Text>
        </Pressable>
      </FormSection>

      <FormSection title="Notes">
        <FormField hint="Carried onto every generated order.">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional"
            multiline
            style={{ minHeight: 60 }}
          />
        </FormField>
      </FormSection>

      <ProductPickerSheet
        visible={pickerOpen}
        activeOnly
        onClose={() => setPickerOpen(false)}
        onSelect={(product) => {
          addLine(product);
          setPickerOpen(false);
        }}
        title="Add product"
      />
    </FormSheet>
    <BarcodeFab onScanned={onScanned} continuous hidden={pickerOpen} />
    </>
  );
}

const styles = StyleSheet.create({
  dayRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  dayChip: {
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    backgroundColor: ios.bgElev,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  dayChipOn: { backgroundColor: ios.brand, borderColor: ios.brand },
  dayChipText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  dayChipTextOn: { color: "#fff" },
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  lineName: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  lineUnit: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 1 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  stepQty: {
    minWidth: 24,
    textAlign: "center",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
  },
  addBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
