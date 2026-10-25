# B889 — mobile buyer edit-items: seller custom lines (bug-pipeline, light loop; Lane U-units, Mac mini)
- Repro (runtime, `test`, qa customer/buyer): #2554 5876190546 — mobile Save sent {productId:null} (200, silently ignored); two custom lines collapsed into one "Product" row; server preserves custom lines (no server bug).
- Fix: PR #2709 — lib/buyer-edit-items skips custom lines (custom = !productId only, lead/SA-566 fold), Save never sends null productId, web's note on the screen. Landed a215587e.
- Proof: red→green pins (7), full mobile jest 226/2932, Expo-web before/after capture (local-assets/proofs/b889-983d9880).
- Real defect caught by review: first cut hid a catalog line with a missing product relation (would be deleted by replace Save) — lead/SA fold.
