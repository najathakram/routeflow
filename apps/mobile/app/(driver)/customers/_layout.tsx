import { Stack } from "expo-router";
import { colors } from "@routeflow/ui/tokens";

export default function CustomersLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: "#fff" },
        headerShadowVisible: false,
        headerTitleStyle: {
          fontFamily: "Inter_600SemiBold",
          fontSize: 17,
          color: colors.navy.DEFAULT,
        },
        headerBackTitle: "Customers",
      }}
    />
  );
}
