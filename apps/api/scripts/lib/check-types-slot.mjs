// The api type ratchet peaks near 3 GB (12 GB heap cap), so it must queue behind the machine-wide heavy slot like every other
// heavy job (2026-11-24: it ran outside the slot and pushed memory over the cap). It must NOT take a second slot when it already
// runs inside one (the pre-push verify exports RF_HEAVY_SLOT_TOKEN), and CI / RF_HEAVY_SLOT=off never use a slot.
export const RATCHET_SLOT_LABEL = "api-ratchet";

/** True when this process should wrap itself in a heavy slot: not CI, not switched off, not already inside a held slot. */
export function needsHeavySlot(env = process.env) {
  return !env.CI && env.RF_HEAVY_SLOT !== "off" && !env.RF_HEAVY_SLOT_TOKEN;
}
