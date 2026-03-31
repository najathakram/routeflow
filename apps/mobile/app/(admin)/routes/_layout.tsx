import { Stack } from "expo-router";
import { colors } from "@routeflow/ui/tokens";
import { HeaderBackButton } from "../../../components/HeaderBackButton";

export default function RoutesLayout() {
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
        headerLeft: () => <HeaderBackButton />,
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "Routes", headerLeft: undefined }}
      />
    </Stack>
  );
}
