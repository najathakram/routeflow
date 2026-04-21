import { Redirect } from "expo-router";

export default function CustomerOrdersRedirect() {
  return <Redirect href="/(customer)/(tabs)/orders" />;
}
