import { useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useProduct } from "../../../lib/api/products";
import { useOrderStore } from "../../../store/orderStore";
import { useFavouritesStore } from "../../../store/favouritesStore";
import { ProductImage } from "../../../components/ProductImage";

function QtyStepper({
  value,
  onDecrease,
  onIncrease,
}: {
  value: number;
  onDecrease: () => void;
  onIncrease: () => void;
}) {
  return (
    <View style={stepperStyles.row}>
      <Pressable
        onPress={onDecrease}
        disabled={value <= 1}
        style={[stepperStyles.btn, value <= 1 && stepperStyles.btnDisabled]}
      >
        <Text style={stepperStyles.btnText}>−</Text>
      </Pressable>
      <Text style={stepperStyles.count}>{value}</Text>
      <Pressable onPress={onIncrease} style={stepperStyles.btn}>
        <Text style={stepperStyles.btnText}>+</Text>
      </Pressable>
    </View>
  );
}

const stepperStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: colors.brand[500],
    alignItems: "center",
    justifyContent: "center",
  },
  btnDisabled: {
    borderColor: colors.surface.border,
  },
  btnText: {
    fontSize: 20,
    lineHeight: 24,
    color: colors.brand[500],
    fontFamily: "Inter_600SemiBold",
  },
  count: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    minWidth: 32,
    textAlign: "center",
  },
});

export default function ProductDetailScreen() {
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const { data: product, isLoading } = useProduct(productId);
  const addItem = useOrderStore((s) => s.addItem);
  const toggle = useFavouritesStore((s) => s.toggle);
  const isFav = useFavouritesStore((s) => s.isFavourite(productId));
  const [quantity, setQuantity] = useState(1);

  if (isLoading) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Loading...</Text>
      </View>
    );
  }

  if (!product) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Product not found.</Text>
      </View>
    );
  }

  const price = parseFloat(String(product.pricePerUnit));
  const priceTiers: Array<{ minQty: number; price: number }> | undefined =
    (product as any).priceTiers;

  const handleAddToOrder = () => {
    addItem(
      {
        id: product.id,
        name: product.name,
        unit: product.unit,
        pricePerUnit: price,
      },
      quantity,
    );
    router.push("/(customer)/order");
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: product.name,
          headerBackTitle: "Shop",
          headerRight: () => (
            <Pressable
              onPress={() => toggle(productId)}
              hitSlop={10}
              accessibilityLabel={isFav ? "Remove from favourites" : "Add to favourites"}
              accessibilityRole="button"
            >
              <Ionicons
                name={isFav ? "heart" : "heart-outline"}
                size={24}
                color={isFav ? colors.danger.DEFAULT : colors.navy.DEFAULT}
              />
            </Pressable>
          ),
        }}
      />
      <View style={styles.container}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Product image(s) */}
          <View style={styles.imageContainer}>
            <ProductImage uri={(product as any).imageUrls?.[0] ?? (product as any).thumbnailUrl} size="lg" />
            {product.lowStock ? (
              <View style={styles.lowStockBanner}>
                <Ionicons
                  name="warning-outline"
                  size={14}
                  color={colors.warning.DEFAULT}
                />
                <Text style={styles.lowStockText}>Low stock — order soon</Text>
              </View>
            ) : null}
          </View>

          {/* Details */}
          <View style={styles.details}>
            <Text style={styles.name}>{product.name}</Text>
            <Text style={styles.unit}>{product.unit}</Text>
            <Text style={styles.price}>${price.toFixed(2)}</Text>

            <View style={styles.divider} />

            <Text style={styles.descriptionLabel}>Description</Text>
            <Text style={styles.description}>{product.description}</Text>

            <View style={styles.divider} />

            {/* Volume Pricing card */}
            {priceTiers && priceTiers.length > 0 ? (
              <>
                <View style={tierStyles.card}>
                  <View style={tierStyles.header}>
                    <Ionicons name="pricetag-outline" size={15} color={colors.brand[500]} />
                    <Text style={tierStyles.title}>Volume Pricing</Text>
                  </View>
                  {priceTiers.map((tier) => (
                    <View key={tier.minQty} style={tierStyles.row}>
                      <Text style={tierStyles.qty}>{tier.minQty}+ units</Text>
                      <Text style={tierStyles.tierPrice}>${Number(tier.price).toFixed(2)} each</Text>
                    </View>
                  ))}
                </View>
                <View style={styles.divider} />
              </>
            ) : null}

            {/* Quantity stepper */}
            <View style={styles.stepperRow}>
              <Text style={styles.qtyLabel}>Quantity</Text>
              <QtyStepper
                value={quantity}
                onDecrease={() => setQuantity((q) => Math.max(1, q - 1))}
                onIncrease={() => setQuantity((q) => q + 1)}
              />
            </View>

            {/* Subtotal */}
            <View style={styles.subtotalRow}>
              <Text style={styles.subtotalLabel}>Subtotal</Text>
              <Text style={styles.subtotalValue}>
                ${(price * quantity).toFixed(2)}
              </Text>
            </View>
          </View>
        </ScrollView>

        {/* Add to Order — full width, anchored at bottom */}
        <View style={styles.footer}>
          <Pressable style={styles.addButton} onPress={handleAddToOrder}>
            <Text style={styles.addButtonText}>
              Add to Order · ${(price * quantity).toFixed(2)}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

const tierStyles = StyleSheet.create({
  card: {
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1,
    borderColor: colors.brand[200] ?? colors.brand[500] + "33",
    padding: 14,
    gap: 8,
    marginBottom: 4,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  title: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[700],
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  qty: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  tierPrice: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: colors.brand[600] ?? colors.brand[500],
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  scroll: {
    paddingBottom: 24,
  },
  imageContainer: {
    height: 240,
    position: "relative",
    overflow: "hidden",
  },
  lowStockBanner: {
    position: "absolute",
    bottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.warning.bg,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  lowStockText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: colors.warning.DEFAULT,
  },
  details: {
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  name: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    marginBottom: 4,
  },
  unit: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
    marginBottom: 8,
  },
  price: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: colors.brand[700],
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface.border,
    marginVertical: 20,
  },
  descriptionLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  description: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    lineHeight: 22,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  qtyLabel: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  subtotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  subtotalLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  subtotalValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    paddingTop: 12,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    ...shadows.card,
  },
  addButton: {
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notFoundText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
