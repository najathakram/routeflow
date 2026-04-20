import React, { Children } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { ios } from "../../tokens";

export interface ListGroupProps {
  children: React.ReactNode;
  style?: ViewStyle;
  /** Optional uppercase section header rendered above the group. */
  header?: string;
  /** Optional footer note rendered below the group. */
  footer?: string;
}

/** iOS-grouped list wrapper — rounded card holding a stack of <ListRow> children. */
export function ListGroup({ children, style, header, footer }: ListGroupProps) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={[styles.section, style]}>
      {header ? <Text style={styles.header}>{header}</Text> : null}
      <View style={styles.group}>
        {rows.map((child, i) => (
          <React.Fragment key={i}>
            {child}
            {i < rows.length - 1 ? <View style={styles.separator} /> : null}
          </React.Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

export interface ListRowProps {
  /** Optional colored icon chip on the left. */
  icon?: React.ReactNode;
  iconBg?: string;
  title: string;
  subtitle?: string;
  /** Optional trailing value (right-aligned text). */
  value?: string;
  /** Optional trailing node (e.g. Pill, chevron). */
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** Show a ›‑style chevron on the right (iOS disclosure indicator). */
  chevron?: boolean;
  /** Vertical padding override for taller rows (e.g. multi-line subs). */
  padY?: number;
}

export function ListRow({
  icon,
  iconBg,
  title,
  subtitle,
  value,
  trailing,
  onPress,
  chevron = false,
  padY,
}: ListRowProps) {
  const inner = (
    <View style={[styles.row, padY !== undefined && { paddingVertical: padY }]}>
      {icon !== undefined ? (
        <View style={[styles.rowIcon, iconBg ? { backgroundColor: iconBg } : null]}>
          {icon}
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? <Text style={styles.value}>{value}</Text> : null}
      {trailing}
      {chevron ? <Text style={styles.chevron}>›</Text> : null}
    </View>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} android_ripple={{ color: ios.fill3 }}>
        {inner}
      </Pressable>
    );
  }
  return inner;
}

const styles = StyleSheet.create({
  section: {
    marginHorizontal: 16,
    marginBottom: 20,
  },
  header: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textTransform: "uppercase",
    letterSpacing: 0.78,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  footer: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingHorizontal: 4,
    paddingTop: 6,
    lineHeight: 18,
  },
  group: {
    backgroundColor: ios.bgElev,
    borderRadius: ios.listRadius,
    overflow: "hidden",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: ios.separator,
    marginLeft: 60,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: ios.rowPadY,
    minHeight: ios.rowMinH,
    backgroundColor: ios.bgElev,
  },
  rowIcon: {
    width: 30,
    height: 30,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: {
    flex: 1,
  },
  title: {
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  value: {
    fontSize: 17,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
  },
  chevron: {
    fontSize: 22,
    fontFamily: "Inter_400Regular",
    color: ios.gray[3],
    marginRight: -4,
  },
});
