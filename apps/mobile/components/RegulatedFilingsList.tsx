import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, Pill } from "@routeflow/ui/mobile/ios";
import { fetchRegulatedFilingUrl, type RegulatedFiling } from "../lib/api/regulated";
import { shareCsv } from "../lib/share-pdf";
import { fmtMoney } from "../lib/regulated-format";
import { showToast } from "../lib/toast";

interface Props {
  filings: RegulatedFiling[];
  /** Show the section name in each row's title (hub roll-up across all sections). */
  showCategory?: boolean;
  /** Resolve a section id → display name. Required when showCategory. */
  categoryName?: (id: string) => string;
  /** Optional copy for the empty state. */
  emptyHint?: string;
  header?: string;
}

/**
 * Shared filings list for the mobile regulated surfaces — the /compliance hub
 * (all sections, showCategory) and the per-section dashboard (one section).
 * Only CSV is offered; PDF generation hasn't shipped server-side (csvKey is the
 * only populated artifact key today — do not add a PDF affordance here).
 */
export function RegulatedFilingsList({
  filings,
  showCategory = false,
  categoryName,
  emptyHint,
  header = "FILINGS",
}: Props) {
  const [sharingId, setSharingId] = useState<string | null>(null);

  const onShare = async (f: RegulatedFiling) => {
    if (!f.csvKey || sharingId) return;
    setSharingId(f.id);
    try {
      const url = await fetchRegulatedFilingUrl(f.id, "csv");
      await shareCsv({
        url,
        filename: `regulated-filing-${f.periodKey}.csv`,
        dialogTitle: "Share filing CSV",
      });
    } catch (e: any) {
      showToast(e?.message ?? "Could not share the CSV.");
    } finally {
      setSharingId(null);
    }
  };

  if (filings.length === 0) {
    return (
      <ListGroup header={header}>
        <View style={styles.emptyRow}>
          <Text style={styles.emptyText}>
            {emptyHint ??
              "No filings prepared yet. Use Prepare filing to generate one for the last completed period."}
          </Text>
        </View>
      </ListGroup>
    );
  }

  return (
    <ListGroup header={header}>
      {filings.map((f) => (
        <ListRow
          key={f.id}
          icon={
            <Ionicons
              name={f.status === "GENERATED" ? "document-text-outline" : "alert-circle"}
              size={16}
              color={f.status === "GENERATED" ? ios.brand : ios.system.redInk}
            />
          }
          iconBg={f.status === "GENERATED" ? ios.brandWash : ios.system.redWash}
          title={
            showCategory && categoryName
              ? `${f.periodKey} · ${categoryName(f.trackedCategoryId)}`
              : f.periodKey
          }
          subtitle={`Net sales ${fmtMoney(f.totalNetSales)} · Tax ${fmtMoney(f.totalCategoryTax)}`}
          trailing={
            sharingId === f.id ? (
              <ActivityIndicator size="small" color={ios.brand} />
            ) : (
              <Pill variant={f.status === "GENERATED" ? "green" : "orange"} small>
                {f.status === "GENERATED" ? "Generated" : "Failed"}
              </Pill>
            )
          }
          onPress={f.csvKey ? () => void onShare(f) : undefined}
          chevron={!!f.csvKey}
        />
      ))}
    </ListGroup>
  );
}

const styles = StyleSheet.create({
  emptyRow: { padding: 16 },
  emptyText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
});
