import { useEffect } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useProduct,
  useDeleteProduct,
  useUpdateProduct,
  useUploadProductImages,
  useDeleteProductImage,
} from "../../../lib/api/products";
import { productImageFile } from "../../../lib/product-image";
import { costPerSellingUnit, formatQtySplit } from "../../../lib/pricing";
import { useInventoryMovements } from "../../../lib/api/inventory";
import { useProductSales, type ProductSaleLine } from "../../../lib/api/product-sales";
import { productSalesSummaryLine, productSaleRowTarget } from "../../../lib/product-sales-logic";
import { useHasAddon, TOBACCO_ADDON } from "../../../lib/api/tobacco";
import { showToast } from "../../../lib/toast";
import { confirm, chooseAction } from "../../../lib/confirm";

function fmtCurrency(n: number | string | undefined | null): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export default function ProductDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // RF-203: defensive guard — if somehow "create" reaches this screen (e.g. the
  // static create.tsx was not matched), redirect to the proper create form
  // instead of firing a doomed /products/create API call and spinning forever.
  const isCreateAlias = id === "create" || id === "new";
  useEffect(() => {
    if (isCreateAlias) router.replace("/(operator)/products/new");
  }, [isCreateAlias, router]);

  const { data: product, isLoading } = useProduct(isCreateAlias ? "" : (id ?? ""));
  const { data: movements } = useInventoryMovements({
    productId: isCreateAlias ? undefined : id,
    limit: 20,
  });
  const { data: sales } = useProductSales(isCreateAlias ? null : id);
  const deleteMut = useDeleteProduct();
  const updateMut = useUpdateProduct();
  const uploadImagesMut = useUploadProductImages();
  const deleteImageMut = useDeleteProductImage();
  const hasTobaccoAddon = useHasAddon(TOBACCO_ADDON);

  if (isLoading || !product) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Product" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const stock = toNumber(product.currentStock);
  const threshold = product.reorderPoint ?? 5;
  const low = stock > 0 && stock <= threshold;
  const out = stock <= 0;

  // imageUrls[i] (presigned, display) lines up 1:1 with imageKeys[i] (delete target).
  const imageUrls: string[] = product.imageUrls ?? [];
  const imageKeys: string[] = product.imageKeys ?? [];

  const pickAndUpload = async (useCamera: boolean) => {
    if (!id) return;
    const res =
      useCamera && Platform.OS !== "web"
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
    if (res.canceled || !res.assets?.[0]) return;
    try {
      // Re-encode to JPEG before upload: an iOS library HEIC pick returns raw HEIC
      // bytes (PHPicker ignores `quality`) and the API stores bytes verbatim —
      // uploading them mislabeled as JPEG yields an undecodable image on web/Android.
      const jpeg = await manipulateAsync(res.assets[0].uri, [], {
        compress: 0.8,
        format: SaveFormat.JPEG,
      });
      const file = productImageFile({ uri: jpeg.uri, mimeType: "image/jpeg" });
      uploadImagesMut.mutate(
        { id, files: [file] },
        {
          onSuccess: () => showToast("Photo added"),
          onError: (e: any) =>
            showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't upload the photo."),
        },
      );
    } catch {
      showToast("Couldn't process the photo.");
    }
  };

  const onAddPhoto = () => {
    const actions =
      Platform.OS === "web"
        ? [
            { label: "Choose photo", onPress: () => pickAndUpload(false) },
            { label: "Cancel", style: "cancel" as const },
          ]
        : [
            { label: "Take photo", onPress: () => pickAndUpload(true) },
            { label: "Choose from library", onPress: () => pickAndUpload(false) },
            { label: "Cancel", style: "cancel" as const },
          ];
    chooseAction("Add product photo", "Add a photo for this product.", actions);
  };

  const onDeletePhoto = (key: string) => {
    if (!id) return;
    confirm(
      "Remove photo?",
      "This photo will be removed from the product.",
      () =>
        deleteImageMut.mutate(
          { id, key },
          {
            onSuccess: () => showToast("Photo removed"),
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't remove the photo."),
          },
        ),
      { confirmText: "Remove", destructive: true },
    );
  };

  const handleDelete = () => {
    if (!id) return;
    confirm(
      "Delete product?",
      `${product.name} will be removed permanently.`,
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Product deleted");
            router.back();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Product"
        leading={<NavBackButton label="Products" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/products/${id}/edit`)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 14 }}>
          <View style={styles.card}>
            <Text style={styles.name}>{product.name}</Text>
            {product.description ? <Text style={styles.desc}>{product.description}</Text> : null}
            <View style={{ flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {out ? (
                <Pill variant="red">Out of stock</Pill>
              ) : low ? (
                <Pill variant="orange">Low stock</Pill>
              ) : null}
              {!product.isActive ? <Pill variant="gray">Inactive</Pill> : null}
              {product.category ? <Pill variant="brand">{product.category}</Pill> : null}
            </View>
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Photos</Text>
              <Pressable onPress={onAddPhoto} disabled={uploadImagesMut.isPending}>
                <Text style={styles.linkText}>
                  {uploadImagesMut.isPending ? "Uploading…" : "Add photo"}
                </Text>
              </Pressable>
            </View>
            {imageUrls.length === 0 ? (
              <Pressable style={styles.photoEmpty} onPress={onAddPhoto}>
                <Ionicons name="camera-outline" size={22} color={ios.label3} />
                <Text style={styles.photoEmptyText}>No photos yet — tap to add.</Text>
              </Pressable>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 10, paddingTop: 4 }}
              >
                {imageUrls.map((url, i) => (
                  <View key={imageKeys[i] ?? url} style={styles.photoThumbWrap}>
                    <Image source={{ uri: url }} style={styles.photoThumb} resizeMode="cover" />
                    {imageKeys[i] ? (
                      <Pressable
                        style={styles.photoDelete}
                        onPress={() => onDeletePhoto(imageKeys[i])}
                        disabled={deleteImageMut.isPending}
                        hitSlop={6}
                      >
                        <Ionicons name="close" size={14} color="#fff" />
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </ScrollView>
            )}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Details</Text>
              <Pressable onPress={() => router.push(`/(operator)/products/${id}/set-cost`)}>
                <Text style={styles.linkText}>Set cost</Text>
              </Pressable>
            </View>
            <Row label="SKU" value={product.sku ?? "—"} />
            <Row label="Barcode" value={product.barcode ?? "—"} />
            <Row label="Unit" value={product.unit ?? "ea"} />
            <Row label="Price" value={`$${toNumber(product.pricePerUnit).toFixed(2)}`} />
            {(() => {
              // averageCost-first precedence (matches NewOrderScreen's cost eye
              // and the server's effectiveValue, which reads standardCost only
              // for STANDARD products — the old standardCost-first order showed
              // a stale hand-typed number over the live weighted average).
              const effectiveCost = product.averageCost ?? product.standardCost;
              if (effectiveCost == null) {
                return (
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Cost</Text>
                    <View style={[styles.marginChip, { backgroundColor: "#FEF3C7" }]}>
                      <Text style={[styles.marginChipText, { color: "#92400E" }]}>No cost set</Text>
                    </View>
                  </View>
                );
              }
              const price = toNumber(product.pricePerUnit);
              // averageCost is per PIECE; pricePerUnit is per SELLING unit (a
              // CASE when unitsPerBox > 1) — compare like with like or margins
              // read inflated by the pack size.
              const cost = costPerSellingUnit(toNumber(effectiveCost), product.unitsPerBox);
              const marginPct = price > 0 ? Math.round(((price - cost) / price) * 100) : null;
              const color =
                marginPct == null || marginPct >= 25
                  ? ios.system.greenInk
                  : marginPct >= 10
                    ? ios.system.orangeInk
                    : ios.system.redInk;
              const bg =
                marginPct == null || marginPct >= 25
                  ? ios.system.greenWash
                  : marginPct >= 10
                    ? ios.system.orangeWash
                    : ios.system.redWash;
              return (
                <>
                  <Row label="Cost" value={`$${cost.toFixed(2)}`} />
                  {marginPct != null ? (
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>Margin</Text>
                      <View style={[styles.marginChip, { backgroundColor: bg }]}>
                        <Text style={[styles.marginChipText, { color }]}>{marginPct}%</Text>
                      </View>
                    </View>
                  ) : null}
                </>
              );
            })()}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Stock</Text>
              <Pressable onPress={() => router.push(`/(operator)/products/${id}/adjust-stock`)}>
                <Text style={styles.linkText}>Adjust</Text>
              </Pressable>
            </View>
            <Row label="On hand" value={`${stock} ${product.unit ?? ""}`.trim()} />
            {product.reorderPoint != null ? (
              <Row label="Reorder at" value={`${product.reorderPoint}`} />
            ) : null}
            {product.reorderQty != null ? (
              <Row label="Reorder qty" value={`${product.reorderQty}`} />
            ) : null}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>Sales</Text>
              {/* PR-B: mirrors the customer detail "View orders" cross-link —
                  same `?productId=` param the orders list chip reads. */}
              <Pressable onPress={() => router.push(`/(operator)/orders?productId=${id}`)}>
                <Text style={styles.linkText}>View orders</Text>
              </Pressable>
            </View>
            {!sales ? (
              <View style={styles.salesEmpty}>
                <ActivityIndicator color={ios.brand} />
              </View>
            ) : sales.lines.length > 0 ? (
              <>
                <Text style={styles.salesSummary}>{productSalesSummaryLine(sales.summary)}</Text>
                <View style={{ marginTop: 6 }}>
                  {/* Only the most recent few render inline — the reader wants
                      "what did we last sell it for", and a long-lived product
                      returns up to 200 lines, which would bury the rest of this
                      screen. The summary strip above still covers ALL of them.
                      "View orders" (header + footer) is the full list. */}
                  {sales.lines.slice(0, SALES_ROWS_INLINE).map((line, i) => (
                    <SaleRow
                      key={`${line.invoiceId}-${line.customerId}-${i}`}
                      line={line}
                      unitLabel={product.unit}
                      bordered={i > 0}
                      onPress={() => {
                        const target = productSaleRowTarget(line);
                        router.push(
                          target.screen === "order"
                            ? `/(operator)/orders/${target.id}`
                            : `/(operator)/invoices/${target.id}`,
                        );
                      }}
                    />
                  ))}
                </View>
                {sales.lines.length > SALES_ROWS_INLINE ? (
                  <Pressable
                    style={styles.salesMoreBtn}
                    onPress={() => router.push(`/(operator)/orders?productId=${id}`)}
                  >
                    <Text style={styles.linkText}>View all {sales.summary.count} sales</Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <View style={styles.salesEmpty}>
                <Text style={styles.salesEmptyText}>No sales yet for this product.</Text>
                <Pressable
                  style={styles.salesEmptyBtn}
                  onPress={() => router.push("/(operator)/new-order")}
                >
                  <Ionicons name="add" size={14} color="#fff" />
                  <Text style={styles.salesEmptyBtnText}>New order</Text>
                </Pressable>
              </View>
            )}
          </View>

          {movements?.data && movements.data.length > 0 ? (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle}>Recent movements</Text>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/(operator)/movements",
                      params: { productId: id, productName: product.name },
                    } as any)
                  }
                >
                  <Text style={styles.linkText}>See all</Text>
                </Pressable>
              </View>
              {movements.data.slice(0, 10).map((m, i) => (
                <View
                  key={m.id}
                  style={[
                    styles.movementRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.movementType}>{m.type}</Text>
                    <Text style={styles.movementMeta}>
                      {new Date(m.createdAt).toLocaleDateString()}
                      {m.notes ? ` · ${m.notes}` : ""}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.movementQty,
                      { color: m.quantity >= 0 ? ios.system.greenInk : ios.system.redInk },
                    ]}
                  >
                    {m.quantity >= 0 ? "+" : ""}
                    {m.quantity}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          {hasTobaccoAddon ? (
            <Pressable
              style={styles.tobaccoBtn}
              onPress={() =>
                updateMut.mutate(
                  { id: id!, isTobacco: !product.isTobacco },
                  {
                    onSuccess: () =>
                      showToast(
                        product.isTobacco ? "Removed tobacco flag" : "Marked as tobacco product",
                      ),
                    onError: (e: any) =>
                      showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                  },
                )
              }
              disabled={updateMut.isPending}
            >
              <Ionicons name="leaf-outline" size={18} color={ios.system.orangeInk} />
              <Text style={styles.tobaccoBtnText}>
                {product.isTobacco ? "Unmark tobacco product" : "Mark as tobacco product"}
              </Text>
            </Pressable>
          ) : null}

          <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={deleteMut.isPending}>
            <Ionicons name="trash-outline" size={18} color={ios.system.red} />
            <Text style={styles.deleteBtnText}>Delete product</Text>
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

/** One card row on the product detail "Sales" card. Card layout (not a wide
 *  table) — this is a phone. Tapping opens the order when `orderId` is set,
 *  else the invoice (`lib/product-sales-logic.ts` `productSaleRowTarget`). */
function SaleRow({
  line,
  unitLabel,
  bordered,
  onPress,
}: {
  line: ProductSaleLine;
  unitLabel?: string | null;
  bordered?: boolean;
  onPress: () => void;
}) {
  const date = new Date(line.date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  // Never re-derive money — qty/unitPrice/lineTotal render exactly as the
  // server sent them; only the boxes+pieces split goes through the shared
  // formatter (mobile mirror of computeLineSubtotal's proration).
  const qtyLabel = formatQtySplit({
    qty: line.qty,
    boxes: line.boxes,
    pieces: line.pieces,
    unitLabel,
  });
  return (
    <Pressable style={[styles.saleRow, bordered ? styles.saleRowBordered : null]} onPress={onPress}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.saleCustomer} numberOfLines={1}>
          {line.customerName}
        </Text>
        <Text style={styles.saleMeta} numberOfLines={1}>
          {date} · {qtyLabel}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
          {line.overridden && line.originalPrice != null ? (
            <Text style={styles.saleOriginalPrice}>{fmtCurrency(line.originalPrice)}</Text>
          ) : null}
          <Text style={styles.salePrice}>{fmtCurrency(line.unitPrice)}</Text>
        </View>
        <Text style={styles.saleTotal}>{fmtCurrency(line.lineTotal)}</Text>
      </View>
    </Pressable>
  );
}

/** Sales rows rendered inline on the product card before deferring to the
 *  product-filtered orders list. The API returns up to 200. */
const SALES_ROWS_INLINE = 8;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  salesSummary: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  salesMoreBtn: { paddingTop: 10, alignItems: "center" },
  saleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
  },
  saleRowBordered: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  saleCustomer: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  saleMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  saleOriginalPrice: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textDecorationLine: "line-through",
  },
  salePrice: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  saleTotal: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    marginTop: 2,
  },
  salesEmpty: { alignItems: "center", gap: 10, paddingVertical: 8 },
  salesEmptyText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  salesEmptyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: ios.brand,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  salesEmptyBtnText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  photoEmpty: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderStyle: "dashed",
  },
  photoEmptyText: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  photoThumbWrap: { position: "relative" },
  photoThumb: { width: 96, height: 120, borderRadius: 10, backgroundColor: ios.fill3 },
  photoDelete: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  tobaccoBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.system.orangeWash,
    borderRadius: 14,
    paddingVertical: 13,
  },
  tobaccoBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.system.orangeInk },
  name: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  detailLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  detailValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  marginChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  marginChipText: { fontSize: 12, fontFamily: "Inter_700Bold" },
  movementRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
  },
  movementType: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  movementMeta: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  movementQty: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.bgElev,
    paddingVertical: 14,
    borderRadius: 12,
  },
  deleteBtnText: { color: ios.system.red, fontSize: 15, fontFamily: "Inter_500Medium" },
});
