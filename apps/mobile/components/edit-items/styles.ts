// #2340 prefactor: moved verbatim out of app/(operator)/(tabs)/orders/[id]/edit-items.tsx
// (size ratchet, plan #2328 R1). Behaviour-neutral — no logic changed in the move.
import { StyleSheet } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { PICKER_TRAY_HANDLE_HEIGHT } from "../../lib/edit-items-draft";

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },

  // ── Card ───────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  cardName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  cardMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  priceTap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  priceStrike: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textDecorationLine: "line-through",
  },
  cardTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  // ── Margin hint (P10-POS-1) ───────────────────────────────────────────────
  marginHint: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
  },
  freeLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    marginTop: 2,
  },
  floorFixBtn: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.system.red,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  floorFixBtnText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.redInk,
  },
  sellAnywayText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    textDecorationLine: "underline",
  },

  // ── Card actions ──────────────────────────────────────────────────────────
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionChipActive: {
    backgroundColor: ios.system.orangeWash,
  },
  actionChipDisabled: { opacity: 0.5 },
  actionChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.system.redWash,
    borderRadius: 8,
  },

  // ── Per-line note (R5.2/R5.3, mirrors NewOrderScreen's cartNote*) ────────
  cartNoteAdd: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
  },
  cartNoteAddText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand },
  cartNoteInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    marginBottom: 6,
  },

  // ── Add product CTA ───────────────────────────────────────────────────────
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 4,
  },
  addBtnDisabled: { opacity: 0.5 },
  addBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  addUnlistedBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
  },

  // ── Unlisted draft card ──────────────────────────────────────────────────
  unlistedTagRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  customTag: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  customTagText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  unlistedNameInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  unlistedPriceRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 },
  unlistedPriceInput: {
    minWidth: 70,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.brand,
    borderRadius: 8,
    textAlign: "right",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    fontVariant: ["tabular-nums"],
  },

  // ── Product picker rows ───────────────────────────────────────────────────
  pickRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  // ── Picker idle state (lazy catalogue) ────────────────────────────────────
  browseBtn: {
    marginTop: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.brand,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  browseBtnText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },

  // ── Picker pull-out drawer ────────────────────────────────────────────────
  pickerTray: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    overflow: "hidden",
  },
  pickerTrayHandle: {
    height: PICKER_TRAY_HANDLE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
  },
  pickerTrayGrabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.fill3,
  },
  pickerTraySummary: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  // ── Restore banner (staged-edit autosave) ─────────────────────────────────
  restoreBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: ios.bgElev,
  },
  restoreText: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  restoreAction: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },

  // ── Picker "last added" strip (B263 D3) ─────────────────────────────────────
  pickerLastAdded: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 96,
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.72)",
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  pickerLastAddedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  pickerLastAddedBelow: {
    flex: 1,
    color: ios.system.red,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  pickerLastAddedText: {
    flex: 1,
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  pickerLastAddedBtn: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  pickerLastAddedBtnText: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footerEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  saveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },

  // ── Price override modal ──────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  modalSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 8,
  },
  modalLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 14,
  },
  modalFieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    marginBottom: 12,
  },
  // B465: a SPECIAL-tier override's reason field reads as required, not
  // optional — a thin red ring, mirroring the web reference's danger styling.
  modalInputError: {
    borderWidth: 1,
    borderColor: ios.system.red,
  },
  modalBtns: { flexDirection: "row", gap: 10 },
  modalBtnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  modalBtnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  modalBtnDisabled: { opacity: 0.4 },
  modalBtnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },

  // ── Apply credit (mirrors NewOrderScreen) ─────────────────────────────────
  optionsWrap: { marginHorizontal: 16, marginTop: 10 },
  optionsHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  optionsTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  optionsSummary: { flex: 1, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  optionsBody: {
    backgroundColor: ios.bgElev,
    borderRadius: 12,
    padding: 12,
    gap: 12,
    marginBottom: 4,
  },
  optionRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  optionLabel: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  newCreditText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
