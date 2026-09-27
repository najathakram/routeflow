/**
 * Badge styling for the native kit (#2332), mirroring web `Badge`: a 21px pill, 10px padding,
 * a 6px dot and 11px semibold uppercase text at 0.03em. Pure, so jest can pin it.
 */
import { TONE_COLORS, type BadgeVariant } from "../status-tones";
import { nativeFonts } from "./tokens";

export const BADGE_HEIGHT = 21;

export function resolveBadgeStyle(variant: BadgeVariant) {
  const c = TONE_COLORS[variant];
  return {
    container: {
      height: BADGE_HEIGHT,
      paddingHorizontal: 10,
      borderRadius: 9999,
      backgroundColor: c.bg,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      alignSelf: "flex-start" as const,
      gap: 6,
    },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg },
    label: {
      fontFamily: nativeFonts.ui[600],
      fontSize: 11,
      letterSpacing: 0.33,
      textTransform: "uppercase" as const,
      color: c.fg,
    },
  };
}
