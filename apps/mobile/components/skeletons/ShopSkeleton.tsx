import { Dimensions, ScrollView, StyleSheet, View } from "react-native";
import { ShimmerBox } from "../Shimmer";
import { borderRadius, shadows } from "@routeflow/ui/tokens";

const SCREEN_WIDTH = Dimensions.get("window").width;
const CARD_WIDTH = (SCREEN_WIDTH - 48) / 2;

function SkeletonCard() {
  return (
    <View style={[styles.card, { width: CARD_WIDTH }]}>
      <ShimmerBox style={styles.cardImage} />
      <View style={styles.cardBody}>
        <ShimmerBox style={styles.cardName} />
        <ShimmerBox style={styles.cardUnit} />
        <View style={styles.cardFooter}>
          <ShimmerBox style={styles.cardPrice} />
          <ShimmerBox style={styles.cardBtn} />
        </View>
      </View>
    </View>
  );
}

export function ShopSkeleton() {
  return (
    <View style={styles.container}>
      {/* Search bar */}
      <ShimmerBox style={styles.search} />

      {/* Category pills */}
      <View style={styles.pillsRow}>
        {[96, 72, 88, 64, 80].map((w, i) => (
          <ShimmerBox key={i} style={[styles.pill, { width: w }]} />
        ))}
      </View>

      {/* Product grid — 3 rows of 2 */}
      <View style={styles.grid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  search: {
    height: 42,
    borderRadius: 8,
    marginBottom: 12,
  },
  pillsRow: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
  },
  pill: {
    height: 30,
    borderRadius: 999,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
  },
  card: {
    backgroundColor: "#f8fafc",
    borderRadius: borderRadius.lg,
    overflow: "hidden",
    ...shadows.card,
  },
  cardImage: {
    height: 110,
    borderRadius: 0,
  },
  cardBody: {
    padding: 10,
    gap: 6,
  },
  cardName: {
    height: 14,
    width: "80%",
    borderRadius: 4,
  },
  cardUnit: {
    height: 11,
    width: "55%",
    borderRadius: 4,
  },
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
  },
  cardPrice: {
    height: 16,
    width: 44,
    borderRadius: 4,
  },
  cardBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
});
