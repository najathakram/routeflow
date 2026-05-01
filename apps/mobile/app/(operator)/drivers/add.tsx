/**
 * RF-211: /drivers/add redirects to /drivers/new (the canonical "Add Driver" form).
 * Some navigation paths (deep-links, More screen) used /drivers/add instead of /drivers/new.
 */
import { Redirect } from "expo-router";

export default function DriversAddRedirect() {
  return <Redirect href="/(operator)/drivers/new" />;
}
