// ─── Return-key generation is a caller concern, not a package opinion ─────────
//
// `buildCaptureRequest` takes `returnKey` as a plain parameter; this package never generates
// one itself, it only carries whatever the caller already minted. The two callers generate it
// differently on purpose: web mints a fresh random identifier per capture attempt and holds it
// in memory (this package's own `mintReturnKey`, web's model — not this package's opinion on
// how every consumer should do it). A future caller offline-queuing a submission cannot do
// that, since a replay after an app kill must reproduce the SAME key rather than mint a new
// one, so it derives one instead of calling `mintReturnKey` at all. Either strategy is valid;
// the seam is that this package only ever receives the result, never the strategy.
export * from "./inline-return-state";
