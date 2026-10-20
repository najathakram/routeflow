/**
 * SA-788: `addon.state_changed` is an audit RECORD (amountDelta null), written for every TenantAddon change - a $0
 * row, a comp, a non-paying tenant. The specs that assert "this change books nothing on the MRR ledger" read the
 * emitted events through this, so they keep proving the ledger while the record is asserted on its own.
 */
export const STATE_CHANGED = "addon.state_changed";

/** The `events.emit` calls that are NOT the per-change audit record. */
export function mrrEmits(events: { emit: { mock: { calls: unknown[][] } } }): unknown[][] {
  return events.emit.mock.calls.filter((c) => c[1] !== STATE_CHANGED);
}

/** The `addon.state_changed` calls only. */
export function stateChanges(events: { emit: { mock: { calls: unknown[][] } } }): unknown[][] {
  return events.emit.mock.calls.filter((c) => c[1] === STATE_CHANGED);
}
