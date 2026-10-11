import { Pressable, Switch, Text, View } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { POS_COPY } from "../lib/pos-mode";

/** The POS mode switch row under the customer chip on NewOrderScreen (staff only). */
export function PosModeSwitch({
  pos,
}: {
  pos: { posMode: boolean; busy: boolean; failed: boolean; flip: (next: boolean) => void };
}) {
  const value = pos.posMode;
  const disabled = pos.busy;
  const failed = pos.failed;
  const onChange = pos.flip;
  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label }}>
            {POS_COPY.switchLabel}
          </Text>
          <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 }}>
            {POS_COPY.switchHint}
          </Text>
        </View>
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          accessibilityLabel={POS_COPY.switchLabel}
        />
      </View>
      {failed ? (
        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: ios.system.red }}>
          {POS_COPY.switchFailed}
        </Text>
      ) : null}
    </View>
  );
}

/** The footer's "Confirm only" link (POS mode, a saveable cart). */
export function PosConfirmOnly({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      style={{ minHeight: 44, minWidth: 44, justifyContent: "center" }}
    >
      <Text style={{ color: ios.brand, fontSize: 13, fontFamily: "Inter_600SemiBold" }}>
        {POS_COPY.confirmOnly}
      </Text>
    </Pressable>
  );
}
