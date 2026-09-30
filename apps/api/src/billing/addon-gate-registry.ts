/**
 * Compatibility re-export. The single source of truth for every grantable feature — including
 * every `@RequireAddon` key's rollout state — is now `feature-registry.ts`. This file stays so
 * `AddonGuard` and `addon-gate-registry.spec.ts` keep importing the same path with
 * byte-identical names and shapes.
 */
export type { AddonGateState, AddonGateEntry } from "./feature-registry";
export { ADDON_GATE_REGISTRY, addonGateState } from "./feature-registry";
