import * as React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FilterChipRow, type FilterChip } from "@routeflow/ui/mobile/ios";
import { OptionPickerSheet, type PickerOption } from "./OptionPickerSheet";
import {
  fetchRegulatedReportCsvText,
  useRegulatedReportPreview,
  type RegulatedReportColumn,
  type RegulatedReportParams,
  type RegulatedReportPreview,
} from "../lib/api/regulated";
import { shareCsvText } from "../lib/share-pdf";
import { showToast } from "../lib/toast";

/**
 * Mobile mirror of the web Reports panel (WP12) — consumes WP11's stateless report
 * endpoints. This app has no date-picker dependency, so "Custom" is two validated
 * YYYY-MM-DD text fields rather than a native picker. A 12-column table (the TX
 * Comptroller shape) is unusable at 375px, so the preview renders one card per row
 * plus a totals card — information parity with the web table, not layout parity.
 */

type Preset = "Last month" | "This month" | "Last quarter" | "YTD" | "Custom";

const PRESET_CHIPS: FilterChip[] = [
  { label: "Last month" },
  { label: "This month" },
  { label: "Last quarter" },
  { label: "YTD" },
  { label: "Custom" },
];

const REPORT_TEMPLATES = ["GENERIC", "CA_CDTFA", "CA_ABC", "CALRECYCLE", "TX_COMPTROLLER"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Inclusive UTC date range for a preset — mobile-local sibling of the web
 * lib/regulated-format.ts#presetRange (this file's lib/regulated-format.ts is out
 * of scope for this package's file list, so the logic lives here instead).
 */
function presetRange(preset: Exclude<Preset, "Custom">, today: Date = new Date()) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-11
  switch (preset) {
    case "This month":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
    case "Last quarter": {
      const q = Math.floor(m / 3); // current quarter, 0-3
      const startMonth = q * 3 - 3; // Date.UTC normalizes negative months into the prior year
      return {
        from: iso(new Date(Date.UTC(y, startMonth, 1))),
        to: iso(new Date(Date.UTC(y, startMonth + 3, 0))),
      };
    }
    case "YTD":
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(today) };
    case "Last month":
    default:
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
  }
}

function slug(v: string): string {
  return (
    v
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "report"
  );
}

interface Props {
  categoryId: string;
  categoryName: string;
  /** The category's configured reportTemplate — used as the "Category default" label/value. */
  defaultTemplate: string;
}

export function RegulatedReportSection({ categoryId, categoryName, defaultTemplate }: Props) {
  const [preset, setPreset] = React.useState<Preset>("Last month");
  const [from, setFrom] = React.useState(() => presetRange("Last month").from);
  const [to, setTo] = React.useState(() => presetRange("Last month").to);
  const [template, setTemplate] = React.useState(""); // "" = category default
  const [templateOpen, setTemplateOpen] = React.useState(false);
  const [warningsOpen, setWarningsOpen] = React.useState(false);
  const [activeParams, setActiveParams] = React.useState<RegulatedReportParams | null>(null);
  const [sharing, setSharing] = React.useState(false);

  const onPreset = (label: string) => {
    const p = label as Preset;
    setPreset(p);
    if (p !== "Custom") {
      const r = presetRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  const validRange = DATE_RE.test(from) && DATE_RE.test(to) && from <= to;
  const params: RegulatedReportParams | null = validRange
    ? { category: categoryId, from, to, ...(template ? { template } : {}) }
    : null;

  const preview = useRegulatedReportPreview(activeParams);

  const handlePreview = () => {
    if (!params) {
      showToast("Enter a valid date range (YYYY-MM-DD, from ≤ to).");
      return;
    }
    setActiveParams(params);
  };

  const handleShare = async () => {
    if (!params || sharing) return;
    setSharing(true);
    try {
      const csv = await fetchRegulatedReportCsvText(params);
      const tpl = params.template || defaultTemplate;
      const filename = `${slug(categoryName)}-${slug(tpl)}-${params.from}-${params.to}.csv`;
      await shareCsvText({ csv, filename, dialogTitle: "Share report CSV" });
    } catch (e: any) {
      showToast(e?.response?.data?.message ?? e?.message ?? "Couldn't share the report.");
    } finally {
      setSharing(false);
    }
  };

  const templateOptions: PickerOption[] = [
    { id: "", label: `Category default (${defaultTemplate})` },
    ...REPORT_TEMPLATES.map((t) => ({ id: t, label: t })),
  ];
  const templateLabel = templateOptions.find((o) => o.id === template)?.label ?? template;

  const warnings = preview.data?.warnings ?? [];
  const shownWarnings = warningsOpen ? warnings : warnings.slice(0, 5);

  return (
    <View style={styles.section}>
      <Text style={styles.header}>REPORTS</Text>
      <View style={styles.card}>
        <FilterChipRow
          chips={PRESET_CHIPS}
          value={preset}
          onChange={onPreset}
          paddingHorizontal={0}
        />

        <View style={styles.dateRow}>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>From</Text>
            <TextInput
              value={from}
              onChangeText={setFrom}
              editable={preset === "Custom"}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={ios.label3}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              style={[styles.dateInput, preset !== "Custom" && styles.dateInputLocked]}
            />
          </View>
          <View style={styles.dateField}>
            <Text style={styles.fieldLabel}>To</Text>
            <TextInput
              value={to}
              onChangeText={setTo}
              editable={preset === "Custom"}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={ios.label3}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={10}
              style={[styles.dateInput, preset !== "Custom" && styles.dateInputLocked]}
            />
          </View>
        </View>
        {!validRange ? (
          <Text style={styles.rangeError}>
            {from && to && from > to
              ? "From must be on or before To."
              : "Dates must be YYYY-MM-DD."}
          </Text>
        ) : null}

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Report template</Text>
          <Pressable style={styles.picker} onPress={() => setTemplateOpen(true)}>
            <View style={styles.pickerInner}>
              <Text style={styles.pickerText} numberOfLines={1}>
                {templateLabel}
              </Text>
              <Ionicons name="chevron-down" size={14} color={ios.label3} />
            </View>
          </Pressable>
        </View>

        <View style={styles.actionRow}>
          <Pressable
            style={[styles.btn, styles.btnPrimary, !validRange && styles.btnDisabled]}
            onPress={handlePreview}
            disabled={!validRange || preview.isFetching}
          >
            {preview.isFetching ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.btnPrimaryText}>Preview</Text>
            )}
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnSecondary, !validRange && styles.btnDisabled]}
            onPress={handleShare}
            disabled={!validRange || sharing}
          >
            {sharing ? (
              <ActivityIndicator size="small" color={ios.brand} />
            ) : (
              <Text style={styles.btnSecondaryText}>Share CSV</Text>
            )}
          </Pressable>
        </View>

        {warnings.length > 0 ? (
          <View style={styles.warnBanner}>
            <View style={styles.warnHeader}>
              <Ionicons name="warning-outline" size={16} color={ios.system.orangeInk} />
              <Text style={styles.warnHeaderText}>
                {warnings.length} warning{warnings.length === 1 ? "" : "s"}
              </Text>
            </View>
            {shownWarnings.map((w, i) => (
              <Text key={i} style={styles.warnText}>
                {"• "}
                {w.message}
              </Text>
            ))}
            {warnings.length > 5 ? (
              <Pressable onPress={() => setWarningsOpen((v) => !v)}>
                <Text style={styles.warnToggle}>
                  {warningsOpen ? "Show less" : `Show all ${warnings.length}`}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {!activeParams ? (
          <Text style={styles.hint}>Choose a range and tap Preview to see the report.</Text>
        ) : preview.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : preview.isError ? (
          <Text style={styles.hint}>Couldn&apos;t load the report. Try again.</Text>
        ) : preview.data ? (
          preview.data.rows.length === 0 ? (
            <Text style={styles.hint}>No regulated sales in this range.</Text>
          ) : (
            <ReportPreviewBody report={preview.data} />
          )
        ) : null}
      </View>

      <OptionPickerSheet
        visible={templateOpen}
        title="Report template"
        options={templateOptions}
        selectedId={template}
        onClose={() => setTemplateOpen(false)}
        onSelect={(o) => {
          setTemplate(o.id);
          setTemplateOpen(false);
        }}
      />
    </View>
  );
}

/** The loaded, non-empty preview: per-row cards plus a totals card. */
function ReportPreviewBody({ report }: { report: RegulatedReportPreview }) {
  return (
    <View style={{ gap: 10, marginTop: 12 }}>
      {report.rows.map((cells, i) => (
        <ReportRowCard key={i} columns={report.columns} cells={cells} />
      ))}
      <TotalsCard
        columns={report.columns}
        totalsRow={report.totalsRow}
        displayTotals={report.displayTotals}
      />
    </View>
  );
}

/**
 * One card per report row — a template-agnostic reflow of `columns` + a row's cells.
 * Right-aligned columns (the report's numeric figures, e.g. Quantity / Invoice Amount
 * on the TX template) surface as headline stats up top; the rest render as label/value
 * pairs below. Works for any template's column set without hardcoding field names.
 */
function ReportRowCard({ columns, cells }: { columns: RegulatedReportColumn[]; cells: string[] }) {
  const rightCols = columns.map((c, i) => ({ c, i })).filter(({ c }) => c.align === "right");
  const leftCols = columns.map((c, i) => ({ c, i })).filter(({ c }) => c.align !== "right");

  return (
    <View style={styles.rowCard}>
      {rightCols.length > 0 ? (
        <View style={styles.rowCardStats}>
          {rightCols.map(({ c, i }) => (
            <View key={c.key} style={styles.rowCardStat}>
              <Text style={styles.rowCardStatValue} numberOfLines={1}>
                {cells[i] || "—"}
              </Text>
              <Text style={styles.rowCardStatLabel} numberOfLines={1}>
                {c.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.rowCardGrid}>
        {leftCols.map(({ c, i }) => {
          const val = cells[i];
          if (!val) return null;
          return (
            <View key={c.key} style={styles.rowCardCell}>
              <Text style={styles.rowCardCellLabel}>{c.label}</Text>
              <Text style={styles.rowCardCellValue} numberOfLines={2}>
                {val}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Totals card: `displayTotals` (headline figures) plus the raw `totalsRow`, when present. */
function TotalsCard({
  columns,
  totalsRow,
  displayTotals,
}: {
  columns: RegulatedReportColumn[];
  totalsRow: string[] | null;
  displayTotals: { label: string; value: string }[];
}) {
  if (displayTotals.length === 0 && !totalsRow) return null;
  return (
    <View style={styles.totalsCard}>
      <Text style={styles.totalsTitle}>Totals</Text>
      {displayTotals.map((t, i) => (
        <View key={i} style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>{t.label}</Text>
          <Text style={styles.totalsValue}>{t.value}</Text>
        </View>
      ))}
      {totalsRow
        ? columns.map((c, i) => {
            const val = totalsRow[i];
            if (!val) return null;
            return (
              <View key={c.key} style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>{c.label}</Text>
                <Text style={styles.totalsValue}>{val}</Text>
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginHorizontal: 16, marginBottom: 20 },
  header: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.78,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  card: { backgroundColor: ios.bgElev, borderRadius: ios.cardRadius, padding: 14, gap: 12 },
  dateRow: { flexDirection: "row", gap: 12 },
  dateField: { flex: 1, gap: 6 },
  field: { gap: 6 },
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  dateInput: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  dateInputLocked: { color: ios.label2 },
  rangeError: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.system.redInk },
  picker: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 44,
    justifyContent: "center",
  },
  pickerInner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  actionRow: { flexDirection: "row", gap: 10 },
  btn: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  btnPrimary: { backgroundColor: ios.brand },
  btnPrimaryText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  btnSecondary: { backgroundColor: ios.brandWash },
  btnSecondaryText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },
  btnDisabled: { opacity: 0.4 },
  hint: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    paddingVertical: 8,
  },
  center: { paddingVertical: 16, alignItems: "center" },
  warnBanner: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  warnHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  warnHeaderText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.system.orangeInk },
  warnText: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.system.orangeInk },
  warnToggle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    marginTop: 2,
  },
  rowCard: {
    backgroundColor: ios.bg,
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  rowCardStats: { flexDirection: "row", gap: 16 },
  rowCardStat: { gap: 2 },
  rowCardStatValue: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  rowCardStatLabel: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2 },
  rowCardGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  rowCardCell: { minWidth: "45%", gap: 1 },
  rowCardCellLabel: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  rowCardCellValue: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  totalsCard: {
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  totalsTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  totalsRow: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  totalsLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, flex: 1 },
  totalsValue: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
