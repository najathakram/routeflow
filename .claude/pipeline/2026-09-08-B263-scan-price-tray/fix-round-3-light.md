# B263 — fix round 3 (light loop, after the engine's final pass)

Light-loop round after the bug-pipeline engine's implementation + review (cause-ruling.md,
build-plan.md); caught in manual exercise of the picker branch, not a registry finding.

**Finding:** the picker strip's below-floor row printed the literal "Below cost" for every
state, choosing its label independently of the line's margin class — the strip and
`DraftItemCard` could disagree on wording for the identical line.

**Design:** the strip's label now derives from the same `computeMarginFraction` +
`classifyMargin` calls `DraftItemCard` uses (new `marginFloor` prop on `ProductPicker`, value =
the list row's own `floorForCategory(marginConfig, category)`). The show/hide gate stays
`needsMarginAck(...)` — one decision helper, one `floorAcked` writer.

**Pin:** `REG-B263-H` in `__tests__/edit-items-scan-price.test.ts` (regex-extracts the list
row's two message literals so the surfaces cannot drift) + two pure cases in
`__tests__/price-override.test.ts`.

**Gates:** tsc clean, prettier clean, 4 suites / 53 tests green.

**Probe:** label reverted → REG-B263-H red, restored → green.
