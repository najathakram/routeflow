/**
 * F30 / R12 (B200) — the buyer's scan-to-cart screen.
 *
 * Customer-role scanning had NO reachable rung at all: the operator ladder
 * (`lib/barcode-resolve.ts`) resolves through `/products/barcode/:code` and
 * `/products?scanCode=`, both `@Roles(OPERATOR, DRIVER)`, so every
 * customer-token lookup 403'd on BOTH rungs — which is why there was no
 * customer scan surface to put this behind. It resolves through the buyer
 * realm's own catalog-scoped rung instead (`resolveBuyerProductByCode` →
 * `GET /buyer/products/scan/:code`), which applies the same isActive +
 * regulated-visibility gate the rest of the buyer catalog does.
 *
 * Continuous by design (mirrors the operator scan surfaces): every branch
 * STAYS in scan mode and reports on the overlay pill, because closing the
 * camera on a mis-read is what stranded the operator in the original report.
 * A hit is added through the same `cartStore.add` the catalog tile's + button
 * uses — same fields, one selling unit — so re-scanning an item increments its
 * line instead of duplicating it, and Done returns to the catalog with the
 * floating cart bar already updated.
 *
 * #2717 M4a-1 (SA-580a): a BUYER hit adds ONE line in the product's DEFAULT unit whatever level
 * the code carries (owner 09-19 v1: buyer orders are default-unit only). The staff level rule
 * (R1-R4, the shared scan-level resolver) is deliberately NOT applied here; `cartStore.add` already adds
 * one selling unit, so a unitSku scan on a boxed product adds a case, never a loose piece.
 */
import { useRouter } from "expo-router";
import { View, StyleSheet } from "react-native";
import { BarcodeScanner } from "../../components/BarcodeScanner";
import { resolveBuyerProductByCode } from "../../lib/api/buyer";
import { SCAN_RESOLVE_TIMEOUT_MS } from "../../lib/scan-ladder";
import type { ScanOutcome } from "../../lib/scan-loop";
import { useCartStore } from "../../store/cartStore";

export default function CustomerScanScreen() {
  const router = useRouter();
  const addToCart = useCartStore((s) => s.add);

  const handleScanned = async (code: string): Promise<ScanOutcome> => {
    // The same per-scan deadline the operator ladder uses, and for the same
    // reason: it ABORTS the lookup rather than racing it, so a resolve the
    // buyer was already told had failed can never add the item afterwards.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), SCAN_RESOLVE_TIMEOUT_MS);
    try {
      const result = await resolveBuyerProductByCode(code, controller.signal);
      if (result.notFound) return { feedback: { kind: "error", text: `No product for "${code}"` } };
      const p = result.product;
      addToCart({
        productId: p.id,
        name: p.name,
        unitPrice: p.buyerPrice,
        unit: p.unit,
        unitsPerBox: p.unitsPerBox ?? null,
        category: p.category ?? null,
      });
      return { feedback: { kind: "added", text: `${p.name} added` } };
    } catch {
      // Network / 5xx / this deadline's abort — never "not found", which would
      // send the buyer looking for a product that is on the shelf.
      return { feedback: { kind: "error", text: "Couldn't look up barcode. Try again." } };
    } finally {
      clearTimeout(deadline);
    }
  };

  return (
    <View style={styles.screen}>
      <BarcodeScanner continuous onScanned={handleScanned} onClose={() => router.back()} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
});
