import { Redirect } from "expo-router";

/**
 * The standalone tobacco screen retired into the Regulated Items hub
 * (compliance pack, 2026-08-24). Kept as a redirect so stale deep links /
 * saved navigation states land in the hub instead of 404ing.
 */
export default function TobaccoRedirect() {
  return <Redirect href="/(operator)/compliance" />;
}
