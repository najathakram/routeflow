import { NewOrderScreen } from "../../components/NewOrderScreen";

// Ad-hoc driver-side order — no stop context. Picks a customer, then
// renders products + save. Used from the driver's empty Route screen.
export default function DriverAdHocNewOrderScreen() {
  return <NewOrderScreen backLabel="Route" />;
}
