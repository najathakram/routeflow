import { useLocalSearchParams } from "expo-router";
import { EditOrderItemsScreen } from "../../../../(operator)/(tabs)/orders/[id]/edit-items";

/**
 * R1e — driver-facing order item editor, reached from a stop's "Edit items" tile.
 * Reuses the operator EditOrderItemsScreen, which branches on the DRIVER role
 * (list pricing / no overrides, and back-to-stop navigation on save). The order id
 * arrives as an `orderId` query param — the route segment is `[stopId]`, so it
 * can't come from the path — and the API's updateOrderItems now accepts a driver
 * edit at any live stage (out-for-delivery / delivered included).
 */
export default function DriverEditItemsScreen() {
  const { orderId } = useLocalSearchParams<{ orderId?: string }>();
  return <EditOrderItemsScreen orderId={orderId} />;
}
