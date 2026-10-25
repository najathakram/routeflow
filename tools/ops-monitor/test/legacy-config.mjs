// The pre-10-22 default lane set (pc-lane, ops-monitor, coordinator, ...). Fixture tests built
// around those ids keep it; the live default is DEFAULT_CONFIG in lib/config.mjs.
import { DEFAULT_CONFIG } from "../lib/config.mjs";

export const LEGACY_CONFIG = {
  ...structuredClone(DEFAULT_CONFIG),
  lanes: [
    { id: "lead", title: "Routeflow Lead", machine: "pc", areas: [] },
    { id: "sa", title: "RouteFlow SA rulings queue", machine: "pc", areas: [] },
    { id: "pc-lane", title: "RouteFlow PC lane planning", machine: "pc", areas: ["*"] },
    {
      id: "macmini",
      title: "RouteFlow Mac mini lane",
      machine: "macmini",
      areas: ["domain:catalog"],
    },
    {
      id: "macbook",
      title: "RouteFlow MacBook lane",
      machine: "macbook",
      areas: ["domain:billing", "domain:finance"],
    },
    { id: "ops-monitor", title: "RouteFlow Ops Monitor", machine: "pc", areas: ["domain:tooling"] },
    { id: "coordinator", title: "RouteFlow Coordinator", machine: "pc", areas: [] },
    { id: "owner", title: "Owner", machine: null, areas: [] },
  ],
  // Lower-cased free text (register "Lane" column, --lane values) → lane id. Longest match wins.
  laneAliases: {
    "pc lane": "pc-lane",
    "pc-lane": "pc-lane",
    "pc-l": "pc-lane",
    "mac mini": "macmini",
    macmini: "macmini",
    mm: "macmini",
    macbook: "macbook",
    mb: "macbook",
    lead: "lead",
    sa: "sa",
    architect: "sa",
    owner: "owner",
    "ops monitor": "ops-monitor",
    "ops-monitor": "ops-monitor",
  },
};
