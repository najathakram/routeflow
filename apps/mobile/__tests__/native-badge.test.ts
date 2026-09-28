/**
 * #2332: the shared status → tone map and the native Badge styling. Imported by path because this
 * jest config stubs `@routeflow/ui/*`.
 */
import {
  BADGE_ENUMS,
  STATUS_TONES,
  TONE_COLORS,
  UI_ONLY_STATUS_VALUES,
  resolveStatusTone,
  type BadgeStatus,
} from "../../../packages/ui/src/status-tones";
import { BADGE_HEIGHT, resolveBadgeStyle } from "../../../packages/ui/src/native/badge-style";
import { ledgerInk, ledgerStatus, ledgerSurface } from "../../../packages/ui/src/tokens/ledger";

describe("shared status tones", () => {
  it("is exhaustive: every value of every badge enum (and every UI-only status) has a tone", () => {
    const expected = new Set<string>([
      ...Object.values(BADGE_ENUMS).flat(),
      ...UI_ONLY_STATUS_VALUES,
    ]);
    const missing = [...expected].filter((v) => !(v in STATUS_TONES));
    expect(missing).toEqual([]);
    // …and nothing outside the derived union sneaks into the map.
    expect(Object.keys(STATUS_TONES).filter((k) => !expected.has(k))).toEqual([]);
  });

  it("UI-only statuses really are not enum values (else they belong to the derived part)", () => {
    const enumValues = new Set<string>(Object.values(BADGE_ENUMS).flat());
    expect(UI_ONLY_STATUS_VALUES.filter((v) => enumValues.has(v))).toEqual([]);
  });

  it("the two statuses the derivation added have deliberate tones", () => {
    expect(STATUS_TONES.PARTIALLY_DELIVERED).toEqual({
      variant: "warning",
      label: "Partially Delivered",
    });
    expect(STATUS_TONES.SKIPPED).toEqual({ variant: "neutral", label: "Skipped" });
  });

  it("keeps the tone and label web shipped for representative statuses", () => {
    const pins: [BadgeStatus, string, string][] = [
      ["DELIVERED", "success", "Delivered"],
      ["PENDING", "warning", "Pending"],
      ["OVERDUE", "danger", "Overdue"],
      ["OUT_FOR_DELIVERY", "info", "Out for Delivery"],
      ["DRAFT", "neutral", "Draft"],
      ["SENT", "warning", "Sent"],
      ["CREDIT_NOTE", "neutral", "Credit Note"],
    ];
    for (const [status, variant, label] of pins) {
      expect(STATUS_TONES[status]).toEqual({ variant, label });
    }
  });

  it("resolves like web Badge: explicit variant and label win, raw status is the last resort", () => {
    expect(resolveStatusTone({ status: "PAID" })).toEqual({ variant: "success", label: "Paid" });
    expect(resolveStatusTone({ status: "PAID", variant: "danger" }).variant).toBe("danger");
    expect(resolveStatusTone({ status: "PAID", label: "Settled" }).label).toBe("Settled");
    expect(resolveStatusTone({ status: "NOT_A_STATUS" as BadgeStatus })).toEqual({
      variant: "neutral",
      label: "NOT_A_STATUS",
    });
    expect(resolveStatusTone({})).toEqual({ variant: "neutral", label: "" });
  });

  it("tints come from the Ledger source; inks are web Badge's literal values", () => {
    expect(TONE_COLORS.success).toEqual({ fg: "#15803D", bg: ledgerStatus.success.bg });
    expect(TONE_COLORS.warning.fg).toBe("#B45309");
    expect(TONE_COLORS.danger.fg).toBe("#B91C1C");
    expect(TONE_COLORS.info.fg).toBe("#0369A1");
    expect(TONE_COLORS.neutral).toEqual({ fg: ledgerInk[500], bg: ledgerSurface.sunken });
  });
});

describe("native Badge style mirrors web", () => {
  it("21px pill, 6px dot, 11px semibold uppercase in the tone ink", () => {
    const s = resolveBadgeStyle("danger");
    expect(s.container.height).toBe(BADGE_HEIGHT);
    expect(BADGE_HEIGHT).toBe(21);
    expect(s.container.paddingHorizontal).toBe(10);
    expect(s.container.backgroundColor).toBe(TONE_COLORS.danger.bg);
    expect(s.dot).toMatchObject({ width: 6, height: 6, backgroundColor: TONE_COLORS.danger.fg });
    expect(s.label).toMatchObject({
      fontFamily: "SplineSans_600SemiBold",
      fontSize: 11,
      textTransform: "uppercase",
      color: TONE_COLORS.danger.fg,
    });
    expect(s.label.letterSpacing).toBeCloseTo(0.03 * 11);
  });
});
