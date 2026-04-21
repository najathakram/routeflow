import { NewOrderScreen } from "../../components/NewOrderScreen";

// Operator-initiated order from Home or Dispatch. Picks a customer, then
// renders products + save. Posts to POST /orders with the operator as creator.
export default function OperatorNewOrderScreen() {
  return <NewOrderScreen backLabel="Back" />;
}
