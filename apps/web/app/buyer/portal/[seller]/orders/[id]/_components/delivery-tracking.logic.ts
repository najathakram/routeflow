/**
 * #2095 — the rules behind the buyer's "Track your delivery" card. Moved to
 * `@routeflow/types` (api/order-tracking-view.ts, #2348) so mobile shows the buyer
 * exactly the same states and copy; re-exported here so this folder's spec keeps
 * pinning the shared source.
 */
export {
  deriveTrackingView,
  firstNameOnly,
  formatDeliveryWindow,
  formatWindowTime,
  stopsBeforeYouLabel,
  type TrackingView,
} from "@routeflow/types";
