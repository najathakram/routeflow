// ─── Return-key generation is a caller concern, not a package opinion ─────────
//
// `buildCaptureRequest` itself never generates a returnKey — it takes one as a plain parameter
// and only carries whatever the caller already minted. This package DOES export one generation
// helper, `mintReturnKey` (a fresh random identifier per capture attempt, held in memory) — but
// that is web's own strategy, offered here because web happens to use it, not this package's
// opinion on how every consumer must generate a key. A caller that has to survive an app kill
// and replay the same submission cannot use `mintReturnKey` at all, since a replay must
// reproduce the SAME key rather than mint a new one — it derives one instead, entirely outside
// this package. Either strategy is valid; the seam is that `buildCaptureRequest` only ever
// receives the result, never the strategy.
export * from "./inline-return-state";
export * from "./return-scan";
