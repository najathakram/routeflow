import {
  buildOperatorNav,
  type OperatorNavContext,
} from "@/app/(dashboard)/_components/build-operator-nav";
import type { NavEntry } from "@/app/(dashboard)/_components/nav-config";

/** A full-plan operator menu with every add-on on (the shape the layout builds for a full tenant). */
export const fullNavContext = (over: Partial<OperatorNavContext> = {}): OperatorNavContext => ({
  role: "OPERATOR",
  canActAsDriver: false,
  routesAccess: true,
  deliveryAccess: true,
  addonsLoading: false,
  hasSalesAgents: false,
  counterEnabled: false,
  regulatedLoading: false,
  regulatedSections: [],
  insightsAccess: false,
  plan: { flags: undefined, resolved: true, failed: false },
  modes: undefined,
  ...over,
});

/** The menu a role would see, built by the same function the layout uses. */
export const navFor = (over: Partial<OperatorNavContext> = {}): NavEntry[] =>
  buildOperatorNav(fullNavContext(over));
