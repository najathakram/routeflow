import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
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
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  useCustomerPrices,
  useUpsertCustomerPrice,
  useDeleteCustomerPrice,
  type CustomerPrice,
} from "../../../../lib/api/customers";
import { useAdminProducts } from "../../../../lib/api/admin";
import { showToast } from "../../../../lib/toast";

function fmt(n: number | string | undefined | null): string {
  const v = n == null ? 0 : typeof n === "string" ? Number(n) : n;
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

interface EditModalProps {
  visible: boolean;
  productId: string;
  productName: string;
  currentPrice: number | null;
  customerId: string;
  onClose: () => void;
}

function EditPriceModal({
  visible,
  productId,
  productName,
  currentPrice,
  customerId,
  onClose,
}: EditModalProps) {
  const [value, setValue] = useState(currentPrice != null ? String(currentPrice) : "");
  const upsert = useUpsertCustomerPrice();

  const save = () => {
    const n = Number(value.trim());
    if (!Number.isFinite(n) || n < 0) {
      Alert.alert("Invalid price", "Enter a valid non-negative price.");
      return;
    }
    upsert.mutate(
      { customerId, productId, price: n },
      {
        onSuccess: () => {
          showToast("Custom price saved");
          onClose();
        },
        onError: () => Alert.alert("Error", "Couldn't save custom price. Try again."),
      },
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>Custom price</Text>
          <Text style={styles.modalProduct} numberOfLines={2}>{productName}</Text>
          <TextInput
            style={styles.priceInput}
            value={value}
            onChangeText={setValue}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            autoFocus
            selectTextOnFocus
          />
          <View style={styles.modalBtns}>
            <Pressable style={[styles.modalBtn, styles.modalBtnCancel]} onPress={onClose}>
              <Text style={styles.modalBtnCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtn, styles.modalBtnSave, upsert.isPending && { opacity: 0.6 }]}
              onPress={save}
              disabled={upsert.isPending}
            >
              <Text style={styles.modalBtnSaveText}>
                {upsert.isPending ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function CustomerCatalogScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const customerId = id ?? "";

  const { data: prices, isLoading: pricesLoading } = useCustomerPrices(customerId);
  const { data: productsData, isLoading: productsLoading } = useAdminProducts({
    isActive: true,
    limit: 200,
  });
  const deleteMut = useDeleteCustomerPrice();

  const [editing, setEditing] = useState<{
    productId: string;
    productName: string;
    currentPrice: number | null;
  } | null>(null);

  const isLoading = pricesLoading || productsLoading;
  const products = productsData?.data ?? [];

  const priceByProduct = new Map<string, CustomerPrice>(
    (prices ?? []).map((p) => [p.productId, p]),
  );

  const handleDelete = (priceId: string, productName: string) => {
    Alert.alert(
      "Remove custom price?",
      `${productName} will revert to the standard price.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            deleteMut.mutate(
              { customerId, priceId },
              {
                onSuccess: () => showToast("Custom price removed"),
                onError: () => Alert.alert("Error", "Couldn't remove. Try again."),
              },
            ),
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Custom prices"
        leading={<NavBackButton label="Customer" onPress={() => router.back()} />}
      />

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          <View style={styles.hint}>
            <Ionicons name="information-circle-outline" size={14} color={ios.label2} />
            <Text style={styles.hintText}>
              Tap a product to set a custom price. Tap the price badge to edit or remove it.
            </Text>
          </View>

          <View style={styles.list}>
            {products.map((product, i) => {
              const custom = priceByProduct.get(product.id);
              const isLast = i === products.length - 1;
              return (
                <Pressable
                  key={product.id}
                  style={[styles.row, !isLast && styles.rowBorder]}
                  onPress={() =>
                    setEditing({
                      productId: product.id,
                      productName: product.name,
                      currentPrice: custom?.price ?? null,
                    })
                  }
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.productName} numberOfLines={1}>
                      {product.name}
                    </Text>
                    <Text style={styles.productSku}>
                      {product.sku ?? product.barcode ?? ""}
                      {product.unit ? ` · ${product.unit}` : ""}
                    </Text>
                  </View>
                  <View style={styles.priceCol}>
                    {custom ? (
                      <Pressable
                        style={styles.customPriceBadge}
                        onPress={() =>
                          handleDelete(custom.id, product.name)
                        }
                      >
                        <Text style={styles.customPriceText}>{fmt(custom.price)}</Text>
                        <Ionicons name="close-circle" size={14} color={ios.brand} />
                      </Pressable>
                    ) : (
                      <Text style={styles.defaultPrice}>{fmt(product.pricePerUnit)}</Text>
                    )}
                  </View>
                </Pressable>
              );
            })}
            {products.length === 0 && (
              <Text style={styles.empty}>No active products found.</Text>
            )}
          </View>
          <View style={{ height: 24 }} />
        </ScrollView>
      )}

      {editing ? (
        <EditPriceModal
          visible
          productId={editing.productId}
          productName={editing.productName}
          currentPrice={editing.currentPrice}
          customerId={customerId}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  hint: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  hintText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, flex: 1 },
  list: {
    marginHorizontal: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  productName: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  productSku: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  priceCol: { alignItems: "flex-end", minWidth: 80 },
  defaultPrice: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  customPriceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  customPriceText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    fontVariant: ["tabular-nums"],
  },
  empty: {
    padding: 16,
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  modal: {
    backgroundColor: ios.bgElev,
    borderRadius: 18,
    padding: 20,
    width: "80%",
    gap: 12,
  },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label, textAlign: "center" },
  modalProduct: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  priceInput: {
    fontSize: 24,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    backgroundColor: ios.fill3,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  modalBtns: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalBtn: {
    flex: 1,
    height: 44,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnCancel: { backgroundColor: ios.fill3 },
  modalBtnCancelText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnSave: { backgroundColor: ios.brand },
  modalBtnSaveText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
